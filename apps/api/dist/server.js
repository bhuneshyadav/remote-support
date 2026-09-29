import { createServer } from "node:http";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Prisma } from "@prisma/client";
import { createSessionSchema, customerAccessSchema, customerDecisionSchema, joinSessionSchema, endSessionSchema, sessionIdSchema, } from "@remote-support/contracts";
import { generateConnectionCode, normalizeConnectionCode } from "./code-utils.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { requireTechnician } from "./auth.js";
import { attachSignaling, closeSignalingSession } from "./signaling.js";
import { createTurnCredentials } from "./turn-credentials.js";
import { digestSecret, expireIfNeeded, isActiveStatus, newDecisionToken, } from "./session-service.js";
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.TRUST_PROXY_HOPS);
app.use(helmet());
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", config.WEB_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
});
const codeAttemptsLimit = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate_limited" },
});
const technicianLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
});
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", async (_req, res) => {
    try {
        await prisma.$queryRaw `SELECT 1`;
        res.json({ status: "ready" });
    }
    catch {
        res.status(503).json({ error: "not_ready" });
    }
});
app.use("/api/v1", technicianLimit);
app.get("/api/v1/me", requireTechnician, async (req, res) => {
    res.json({ technician: req.technician });
});
app.post("/api/v1/sessions", requireTechnician, async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const technician = req.technician;
    const expiresAt = new Date(Date.now() + config.SESSION_PENDING_MINUTES * 60_000);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const code = generateConnectionCode();
        const codeHash = digestSecret(code);
        try {
            const session = await prisma.$transaction(async (tx) => {
                const created = await tx.supportSession.create({
                    data: {
                        organizationId: technician.organizationId,
                        technicianId: technician.id,
                        purpose: parsed.data.purpose,
                        codeHash,
                        expiresAt,
                    },
                    select: { id: true, purpose: true, status: true, createdAt: true, expiresAt: true },
                });
                await tx.auditEvent.create({
                    data: {
                        organizationId: technician.organizationId,
                        sessionId: created.id,
                        actorType: "technician",
                        actorId: technician.id,
                        eventType: "created",
                    },
                });
                return created;
            });
            res.status(201).json({ ...session, code });
            return;
        }
        catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
                continue;
            throw error;
        }
    }
    res.status(503).json({ error: "could_not_create_session" });
});
app.get("/api/v1/sessions", requireTechnician, async (req, res) => {
    const technician = req.technician;
    const rawLimit = Number(req.query.limit ?? 25);
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
    const sessions = await prisma.supportSession.findMany({
        where: { organizationId: technician.organizationId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
            id: true,
            purpose: true,
            status: true,
            createdAt: true,
            expiresAt: true,
            technician: { select: { displayName: true } },
        },
    });
    const current = await Promise.all(sessions.map(async (session) => ({
        current: await expireIfNeeded(session.id),
        technicianName: session.technician.displayName,
    })));
    res.json({ sessions: current.flatMap(({ current: session, technicianName }) => session ? [{
                id: session.id,
                purpose: session.purpose,
                status: session.status,
                createdAt: session.createdAt,
                expiresAt: session.expiresAt,
                technicianName,
            }] : []) });
});
app.get("/api/v1/sessions/:id", requireTechnician, async (req, res) => {
    const id = sessionIdSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const technician = req.technician;
    const session = await prisma.supportSession.findFirst({
        where: { id: id.data, organizationId: technician.organizationId },
        select: {
            id: true,
            purpose: true,
            status: true,
            createdAt: true,
            expiresAt: true,
            technician: { select: { displayName: true } },
        },
    });
    if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const current = await expireIfNeeded(session.id);
    res.json({ session: current ? {
            id: current.id,
            purpose: current.purpose,
            status: current.status,
            createdAt: current.createdAt,
            expiresAt: current.expiresAt,
            technicianName: session.technician.displayName,
        } : null });
});
app.get("/api/v1/sessions/:id/ice-credentials", requireTechnician, async (req, res) => {
    const id = sessionIdSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const technician = req.technician;
    const session = await prisma.supportSession.findFirst({
        where: { id: id.data, organizationId: technician.organizationId },
        select: { id: true, status: true, expiresAt: true, screenViewingGranted: true },
    });
    if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const current = await expireIfNeeded(session.id);
    if (!current || current.status === "expired") {
        closeSignalingSession(session.id, "expired");
        res.status(409).json({ error: "session_expired" });
        return;
    }
    if (current.status !== "approved" || !current.screenViewingGranted) {
        res.status(409).json({ error: "session_not_ready" });
        return;
    }
    if (current.expiresAt <= new Date()) {
        closeSignalingSession(current.id, "expired");
        res.status(409).json({ error: "session_expired" });
        return;
    }
    if (!config.TURN_URLS || !config.TURN_SHARED_SECRET) {
        res.status(503).json({ error: "turn_not_configured" });
        return;
    }
    const urls = config.TURN_URLS.split(",").map((url) => url.trim()).filter(Boolean);
    const remainingSeconds = Math.floor((current.expiresAt.getTime() - Date.now()) / 1000);
    const lifetimeSeconds = Math.min(300, remainingSeconds);
    if (lifetimeSeconds < 60) {
        res.status(409).json({ error: "session_expiring" });
        return;
    }
    const credentials = createTurnCredentials(current.id, urls, config.TURN_SHARED_SECRET, new Date(), lifetimeSeconds);
    res.setHeader("Cache-Control", "no-store");
    res.json({ iceServers: [credentials], expiresAt: new Date(Date.now() + lifetimeSeconds * 1000) });
});
app.post("/api/v1/sessions/:id/end", requireTechnician, async (req, res) => {
    const parsed = endSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const id = sessionIdSchema.safeParse(req.params.id);
    if (!id.success) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const technician = req.technician;
    const session = await prisma.supportSession.findFirst({
        where: { id: id.data, organizationId: technician.organizationId },
    });
    if (!session) {
        res.status(404).json({ error: "session_not_found" });
        return;
    }
    const current = await expireIfNeeded(session.id);
    if (!current || !isActiveStatus(current.status)) {
        res.json({ status: current?.status ?? "expired" });
        return;
    }
    const ended = await prisma.$transaction(async (tx) => {
        const update = await tx.supportSession.updateMany({
            where: {
                id: current.id,
                status: current.status,
                version: current.version,
                expiresAt: { gt: new Date() },
            },
            data: {
                status: "ended",
                endedAt: new Date(),
                codeHash: null,
                decisionTokenHash: null,
                customerAccessTokenHash: null,
                screenViewingGranted: false,
                version: { increment: 1 },
            },
        });
        if (update.count !== 1)
            return false;
        await tx.auditEvent.create({
            data: {
                organizationId: current.organizationId,
                sessionId: current.id,
                actorType: "technician",
                actorId: technician.id,
                eventType: "ended",
            },
        });
        return true;
    });
    if (ended)
        closeSignalingSession(current.id, "ended");
    const latest = await expireIfNeeded(current.id);
    res.json({ status: latest?.status ?? "expired" });
});
app.post("/api/v1/customer/sessions/join", codeAttemptsLimit, async (req, res) => {
    const parsed = joinSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const normalizedCode = normalizeConnectionCode(parsed.data.code);
    const session = await prisma.supportSession.findFirst({
        where: { codeHash: digestSecret(normalizedCode), status: "waiting_for_customer" },
        include: { technician: true, organization: true },
    });
    if (!session || session.expiresAt <= new Date()) {
        res.status(404).json({ error: "invalid_or_expired_code" });
        return;
    }
    const token = newDecisionToken();
    const customerToken = newDecisionToken();
    const transitioned = await prisma.$transaction(async (tx) => {
        const update = await tx.supportSession.updateMany({
            where: {
                id: session.id,
                status: "waiting_for_customer",
                version: session.version,
                expiresAt: { gt: new Date() },
            },
            data: {
                status: "awaiting_approval",
                codeHash: null,
                decisionTokenHash: digestSecret(token),
                customerAccessTokenHash: digestSecret(customerToken),
                version: { increment: 1 },
            },
        });
        if (update.count !== 1)
            return false;
        await tx.auditEvent.create({
            data: {
                organizationId: session.organizationId,
                sessionId: session.id,
                actorType: "customer",
                eventType: "customer_joined",
            },
        });
        return true;
    });
    if (!transitioned) {
        res.status(404).json({ error: "invalid_or_expired_code" });
        return;
    }
    res.json({
        decisionToken: token,
        customerToken,
        sessionId: session.id,
        session: {
            id: session.id,
            purpose: session.purpose,
            organizationName: session.organization.name,
            technicianName: session.technician.displayName,
            expiresAt: session.expiresAt,
            status: "awaiting_approval",
        },
    });
});
app.post("/api/v1/customer/sessions/decision", async (req, res) => {
    const parsed = customerDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const session = await prisma.supportSession.findFirst({
        where: {
            decisionTokenHash: digestSecret(parsed.data.decisionToken),
            status: "awaiting_approval",
        },
    });
    if (!session || session.expiresAt <= new Date()) {
        res.status(404).json({ error: "session_not_available" });
        return;
    }
    const nextStatus = parsed.data.decision === "approve" ? "approved" : "rejected";
    const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.supportSession.updateMany({
            where: {
                id: session.id,
                version: session.version,
                status: "awaiting_approval",
                expiresAt: { gt: new Date() },
            },
            data: {
                status: nextStatus,
                codeHash: null,
                decisionTokenHash: null,
                customerAccessTokenHash: nextStatus === "approved" ? session.customerAccessTokenHash : null,
                expiresAt: nextStatus === "approved"
                    ? new Date(Date.now() + config.SESSION_MAX_MINUTES * 60_000)
                    : session.expiresAt,
                screenViewingGranted: false,
                version: { increment: 1 },
            },
        });
        if (result.count !== 1)
            return false;
        await tx.auditEvent.create({
            data: {
                organizationId: session.organizationId,
                sessionId: session.id,
                actorType: "customer",
                eventType: nextStatus,
            },
        });
        return true;
    });
    if (!updated) {
        res.status(409).json({ error: "session_state_changed" });
        return;
    }
    if (nextStatus !== "approved")
        closeSignalingSession(session.id, nextStatus);
    res.json({ status: nextStatus });
});
app.post("/api/v1/customer/sessions/status", async (req, res) => {
    const parsed = customerAccessSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const session = await prisma.supportSession.findFirst({
        where: { customerAccessTokenHash: digestSecret(parsed.data.customerToken) },
        select: { id: true, status: true, expiresAt: true },
    });
    if (!session) {
        res.status(404).json({ error: "session_not_available" });
        return;
    }
    const current = await expireIfNeeded(session.id);
    res.json({ status: current?.status ?? "expired", expiresAt: current?.expiresAt ?? session.expiresAt });
});
app.post("/api/v1/customer/sessions/end", async (req, res) => {
    const parsed = customerAccessSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "invalid_request" });
        return;
    }
    const session = await prisma.supportSession.findFirst({
        where: { customerAccessTokenHash: digestSecret(parsed.data.customerToken) },
    });
    if (!session) {
        res.status(404).json({ error: "session_not_available" });
        return;
    }
    const current = await expireIfNeeded(session.id);
    if (!current || !isActiveStatus(current.status)) {
        res.json({ status: current?.status ?? "expired" });
        return;
    }
    const ended = await prisma.$transaction(async (tx) => {
        const result = await tx.supportSession.updateMany({
            where: {
                id: current.id,
                status: current.status,
                version: current.version,
                expiresAt: { gt: new Date() },
            },
            data: {
                status: "ended",
                endedAt: new Date(),
                codeHash: null,
                decisionTokenHash: null,
                customerAccessTokenHash: null,
                screenViewingGranted: false,
                version: { increment: 1 },
            },
        });
        if (result.count !== 1)
            return false;
        await tx.auditEvent.create({
            data: {
                organizationId: current.organizationId,
                sessionId: current.id,
                actorType: "customer",
                eventType: "ended",
            },
        });
        return true;
    });
    if (ended)
        closeSignalingSession(current.id, "ended");
    const latest = await expireIfNeeded(current.id);
    res.json({ status: ended ? "ended" : latest?.status ?? "session_state_changed" });
});
app.use((error, _req, res, _next) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        console.error("database_request_failed", error.code);
    }
    else {
        console.error("request_failed", error instanceof Error ? error.name : "unknown_error");
    }
    res.status(500).json({ error: "internal_server_error" });
});
const server = createServer(app);
attachSignaling(server);
server.listen(config.PORT, config.HOST, () => {
    console.log(`API listening on ${config.HOST}:${config.PORT}`);
});
const expiryTimer = setInterval(() => {
    void prisma.supportSession.findMany({
        where: {
            status: { in: ["waiting_for_customer", "awaiting_approval", "approved"] },
            expiresAt: { lte: new Date() },
        },
        select: { id: true },
        take: 100,
    }).then((expired) => Promise.all(expired.map(({ id }) => expireIfNeeded(id))))
        .catch((error) => {
        console.error("session_expiry_worker_failed", error instanceof Error ? error.name : "unknown_error");
    });
}, 30_000);
expiryTimer.unref();
async function shutdown() {
    clearInterval(expiryTimer);
    server.close();
    await prisma.$disconnect();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
