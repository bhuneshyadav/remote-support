import { randomBytes } from "node:crypto";
import { prisma } from "./db.js";
import { config } from "./config.js";
import { digestSecret as digest } from "./code-utils.js";
const ACTIVE_STATUSES = [
    "waiting_for_customer",
    "awaiting_approval",
    "approved",
];
export function digestSecret(value) {
    return digest(value, config.SESSION_CODE_HMAC_KEY);
}
export async function expireIfNeeded(sessionId, now = new Date()) {
    return prisma.$transaction(async (tx) => {
        const session = await tx.supportSession.findUnique({ where: { id: sessionId } });
        if (!session || !ACTIVE_STATUSES.includes(session.status) || session.expiresAt > now)
            return session;
        const updated = await tx.supportSession.updateMany({
            where: { id: session.id, status: session.status, version: session.version },
            data: {
                status: "expired",
                codeHash: null,
                decisionTokenHash: null,
                customerAccessTokenHash: null,
                screenViewingGranted: false,
                version: { increment: 1 },
            },
        });
        if (updated.count !== 1)
            return tx.supportSession.findUnique({ where: { id: sessionId } });
        await tx.auditEvent.create({
            data: {
                organizationId: session.organizationId,
                sessionId: session.id,
                actorType: "system",
                eventType: "expired",
            },
        });
        return tx.supportSession.findUnique({ where: { id: sessionId } });
    });
}
export function isActiveStatus(status) {
    return ACTIVE_STATUSES.includes(status);
}
export function newDecisionToken() {
    return randomBytes(32).toString("base64url");
}
