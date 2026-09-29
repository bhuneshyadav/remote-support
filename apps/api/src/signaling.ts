import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import { webSocketSignalingMessageSchema } from "@remote-support/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { verifyTechnicianAccessToken } from "./auth.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { digestSecret, expireIfNeeded } from "./session-service.js";
import { createTurnCredentials } from "./turn-credentials.js";

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CONNECTIONS = 2_000;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 200;
const AUTH_TIMEOUT_MS = 10_000;
const SESSION_CHECK_INTERVAL_MS = 5_000;
type PeerRole = "technician" | "customer";

interface Peer {
  socket: WebSocket;
  role: PeerRole;
  principalId?: string;
  principalTokenExpiresAt?: number;
  customerTokenHash?: string;
}

interface Room {
  peers: Map<PeerRole, Peer>;
  screenViewingGranted: boolean;
  expiryTimer?: NodeJS.Timeout;
}

const rooms = new Map<string, Room>();

function send(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close(1011, "send_failed");
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason);
  }
}

function isMatchingDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, message: string) {
  socket.once("error", () => undefined);
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function isAllowedOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  return origin === undefined || origin === new URL(config.WEB_ORIGIN).origin;
}

function notifyAndCloseRoom(sessionId: string, status: string) {
  const room = rooms.get(sessionId);
  if (!room) return;
  rooms.delete(sessionId);
  if (room.expiryTimer) clearTimeout(room.expiryTimer);
  for (const peer of room.peers.values()) {
    send(peer.socket, { type: "status", status });
    closeSocket(peer.socket, 4003, `session_${status}`);
  }
}

function setRoomViewingConsent(sessionId: string, granted: boolean) {
  const room = rooms.get(sessionId);
  if (!room || room.screenViewingGranted === granted) return;
  room.screenViewingGranted = granted;
  const status = granted ? "viewing_granted" : "viewing_revoked";
  const technician = room.peers.get("technician");
  if (technician) send(technician.socket, { type: "status", status });
  const customer = room.peers.get("customer");
  if (customer) send(customer.socket, { type: "status", status });
}

async function sendIceCredentials(sessionId: string, recipients?: Peer[]) {
  const room = rooms.get(sessionId);
  if (!room?.screenViewingGranted) return;
  const peers = recipients ?? [...room.peers.values()];
  const authenticatedPeers = peers.filter(
    (peer) => room.peers.get(peer.role) === peer && peer.socket.readyState === WebSocket.OPEN,
  );
  if (!authenticatedPeers.length) return;

  const session = await prisma.supportSession.findUnique({
    where: { id: sessionId },
    select: { status: true, screenViewingGranted: true, expiresAt: true },
  });
  if (!session || session.status !== "approved" || !session.screenViewingGranted
    || rooms.get(sessionId) !== room || !room.screenViewingGranted) return;
  if (session.expiresAt <= new Date()) {
    const latest = await expireIfNeeded(sessionId);
    notifyAndCloseRoom(sessionId, latest?.status ?? "expired");
    return;
  }
  const turnUrls = config.TURN_URLS;
  const turnSharedSecret = config.TURN_SHARED_SECRET;
  if (!turnUrls || !turnSharedSecret) {
    for (const peer of authenticatedPeers) {
      send(peer.socket, { type: "status", status: "turn_unavailable" });
    }
    return;
  }

  const remainingSeconds = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
  const lifetimeSeconds = Math.min(300, remainingSeconds);
  if (lifetimeSeconds < 60) {
    for (const peer of authenticatedPeers) {
      send(peer.socket, { type: "status", status: "session_expiring" });
    }
    return;
  }
  const urls = turnUrls.split(",").map((url) => url.trim()).filter(Boolean);
  if (!urls.length) {
    for (const peer of authenticatedPeers) {
      send(peer.socket, { type: "status", status: "turn_unavailable" });
    }
    return;
  }
  const message = () => ({
    type: "ice_servers",
    servers: [createTurnCredentials(
      sessionId,
      urls,
      turnSharedSecret,
      new Date(),
      lifetimeSeconds,
    )],
  });
  if (rooms.get(sessionId) !== room || !room.screenViewingGranted) return;
  for (const peer of authenticatedPeers) {
    if (room.peers.get(peer.role) === peer && peer.socket.readyState === WebSocket.OPEN) {
      send(peer.socket, message());
    }
  }
}

export function closeSignalingSession(sessionId: string, status: string) {
  notifyAndCloseRoom(sessionId, status);
}

async function validateRoom(sessionId: string): Promise<boolean> {
  const room = rooms.get(sessionId);
  if (!room) return false;

  const session = await prisma.supportSession.findUnique({
    where: { id: sessionId },
    select: {
      organizationId: true,
      status: true,
      expiresAt: true,
      customerAccessTokenHash: true,
      screenViewingGranted: true,
    },
  });
  if (!session) {
    notifyAndCloseRoom(sessionId, "revoked");
    return false;
  }
  if (session.expiresAt <= new Date()) {
    const latest = await expireIfNeeded(sessionId);
    notifyAndCloseRoom(sessionId, latest?.status ?? "expired");
    return false;
  }
  if (session.status !== "approved") {
    notifyAndCloseRoom(sessionId, session.status);
    return false;
  }
  setRoomViewingConsent(sessionId, session.screenViewingGranted);

  const customer = room.peers.get("customer");
  if (customer && (!customer.customerTokenHash || !session.customerAccessTokenHash
    || !isMatchingDigest(customer.customerTokenHash, session.customerAccessTokenHash))) {
    notifyAndCloseRoom(sessionId, "revoked");
    return false;
  }
  const technician = room.peers.get("technician");
  if (technician?.principalId) {
    if (!technician.principalTokenExpiresAt
      || technician.principalTokenExpiresAt <= Math.floor(Date.now() / 1000)) {
      notifyAndCloseRoom(sessionId, "revoked");
      return false;
    }
    const currentTechnician = await prisma.technician.findUnique({
      where: { id: technician.principalId },
      select: { organizationId: true, role: true },
    });
    if (!currentTechnician || currentTechnician.organizationId !== session.organizationId
      || (currentTechnician.role !== "technician" && currentTechnician.role !== "admin")) {
      notifyAndCloseRoom(sessionId, "revoked");
      return false;
    }
  }
  return true;
}

async function persistViewingConsent(sessionId: string, peer: Peer, granted: boolean): Promise<boolean> {
  const customerTokenHash = peer.customerTokenHash;
  if (peer.role !== "customer" || !customerTokenHash) return false;
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const session = await tx.supportSession.findUnique({
      where: { id: sessionId },
      select: {
        status: true,
        expiresAt: true,
        customerAccessTokenHash: true,
        screenViewingGranted: true,
        version: true,
        organizationId: true,
      },
    });
    if (!session || session.status !== "approved" || session.expiresAt <= now
      || !session.customerAccessTokenHash
      || !isMatchingDigest(customerTokenHash, session.customerAccessTokenHash)) {
      return false;
    }
    if (session.screenViewingGranted === granted) return true;

    const updated = await tx.supportSession.updateMany({
      where: {
        id: sessionId,
        status: "approved",
        version: session.version,
        expiresAt: { gt: now },
        customerAccessTokenHash: customerTokenHash,
      },
      data: {
        screenViewingGranted: granted,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) return false;
    await tx.auditEvent.create({
      data: {
        organizationId: session.organizationId,
        sessionId,
        actorType: "customer",
        eventType: granted ? "viewing_granted" : "viewing_revoked",
      },
    });
    return true;
  });
}

export function attachSignaling(server: Server) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  websocketServer.on("error", () => {
    console.error("websocket_server_failed");
  });

  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/api/v1/ws" || url.search || !isAllowedOrigin(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (websocketServer.clients.size >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    try {
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        websocketServer.emit("connection", client, request);
      });
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
    }
  });

  websocketServer.on("connection", (socket) => {
    let peer: Peer | undefined;
    let sessionId: string | undefined;
    let authTimeout: NodeJS.Timeout | undefined;
    let queue = Promise.resolve();
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;

    const fail = (error: string, code = 1008) => {
      send(socket, { type: "error", error });
      closeSocket(socket, code, error);
    };

    const authenticate = async (auth: { sessionId: string; token: string }) => {
      const currentSession = await prisma.supportSession.findUnique({
        where: { id: auth.sessionId },
        select: {
          organizationId: true,
          status: true,
          expiresAt: true,
          customerAccessTokenHash: true,
          screenViewingGranted: true,
        },
      });
      if (!currentSession) {
        fail("session_not_available");
        return;
      }
      if (currentSession.expiresAt <= new Date()) {
        const latest = await expireIfNeeded(auth.sessionId);
        send(socket, { type: "status", status: latest?.status ?? "expired" });
        closeSocket(socket, 1008, "session_expired");
        return;
      }
      if (currentSession.status !== "approved") {
        send(socket, { type: "status", status: currentSession.status });
        closeSocket(socket, 1008, "session_not_approved");
        return;
      }

      let authenticatedPeer: Peer | undefined;
      if (currentSession.customerAccessTokenHash
        && isMatchingDigest(digestSecret(auth.token), currentSession.customerAccessTokenHash)) {
        const tokenHash = digestSecret(auth.token);
        authenticatedPeer = { socket, role: "customer", customerTokenHash: tokenHash };
      } else {
        const verified = await verifyTechnicianAccessToken(auth.token);
        if (verified) {
          const technician = await prisma.technician.findUnique({
            where: { id: verified.subject },
            select: { id: true, organizationId: true, role: true },
          });
          if (technician && technician.organizationId === currentSession.organizationId
            && (technician.role === "technician" || technician.role === "admin")) {
            authenticatedPeer = {
              socket,
              role: "technician",
              principalId: technician.id,
              principalTokenExpiresAt: verified.expiresAt,
            };
          }
        }
      }
      if (!authenticatedPeer) {
        fail("unauthorized");
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) return;

      let room = rooms.get(auth.sessionId);
      if (!room) {
        room = {
          peers: new Map(),
          screenViewingGranted: currentSession.screenViewingGranted,
        };
        rooms.set(auth.sessionId, room);
        const expiresIn = Math.max(0, currentSession.expiresAt.getTime() - Date.now());
        room.expiryTimer = setTimeout(() => {
          void validateRoom(auth.sessionId).catch(() => {
            console.error("websocket_session_expiry_failed");
            notifyAndCloseRoom(auth.sessionId, "unavailable");
          });
        }, expiresIn);
        room.expiryTimer.unref();
      } else {
        setRoomViewingConsent(auth.sessionId, currentSession.screenViewingGranted);
      }
      if (room.peers.get(authenticatedPeer.role)?.socket.readyState === WebSocket.OPEN) {
        fail("peer_already_connected");
        return;
      }

      sessionId = auth.sessionId;
      peer = authenticatedPeer;
      room.peers.set(peer.role, peer);
      if (authTimeout) clearTimeout(authTimeout);
      send(socket, {
        type: "auth_ok",
        role: peer.role,
        screenViewingGranted: room.screenViewingGranted,
      });
      send(socket, { type: "status", status: "approved" });
      if (peer.role === "technician") {
        send(socket, {
          type: "status",
          status: room.screenViewingGranted ? "viewing_granted" : "viewing_pending",
        });
      }
      if (room.screenViewingGranted) {
        await sendIceCredentials(auth.sessionId, [peer]).catch(() => {
          console.error("websocket_ice_credentials_failed");
        });
      }

      const otherRole = peer.role === "technician" ? "customer" : "technician";
      const otherPeer = room.peers.get(otherRole);
      if (otherPeer?.socket.readyState === WebSocket.OPEN) {
        send(socket, { type: "participant_connected", role: otherRole });
        send(otherPeer.socket, { type: "participant_connected", role: peer.role });
      }
    };

    const handleMessage = async (data: RawData, isBinary: boolean) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - messageWindowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
        messageWindowStartedAt = now;
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount > MAX_MESSAGES_PER_WINDOW) {
        fail("message_rate_limited");
        return;
      }
      if (isBinary) {
        fail("text_messages_only");
        return;
      }
      const bytes = rawDataBuffer(data);
      if (bytes.byteLength > MAX_MESSAGE_BYTES) {
        fail("message_too_large");
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(bytes.toString("utf8"));
      } catch {
        fail("invalid_json");
        return;
      }
      const parsed = webSocketSignalingMessageSchema.safeParse(message);
      if (!parsed.success) {
        fail("invalid_message");
        return;
      }
      if (!peer) {
        if (parsed.data.type !== "auth" || sessionId) {
          fail("authentication_required");
          return;
        }
        sessionId = parsed.data.sessionId;
        await authenticate(parsed.data);
        return;
      }
      if (parsed.data.type === "auth") {
        fail("already_authenticated");
        return;
      }
      if (!sessionId || !await validateRoom(sessionId)) return;
      if (socket.readyState !== WebSocket.OPEN
        || rooms.get(sessionId)?.peers.get(peer.role)?.socket !== socket) return;
      if (parsed.data.type === "grant_viewing") {
        if (peer.role !== "customer") {
          fail("customer_only");
          return;
        }
        if (!await persistViewingConsent(sessionId, peer, parsed.data.granted)) {
          if (!await validateRoom(sessionId)) return;
          fail("session_state_changed");
          return;
        }
        setRoomViewingConsent(sessionId, parsed.data.granted);
        if (parsed.data.granted) {
          void sendIceCredentials(sessionId).catch(() => {
            console.error("websocket_ice_credentials_failed");
          });
        }
        return;
      }
      const room = rooms.get(sessionId);
      const technician = room?.peers.get("technician");
      const customer = room?.peers.get("customer");
      if (!room?.screenViewingGranted) {
        send(socket, { type: "status", status: "viewing_revoked" });
        return;
      }
      if (technician?.socket.readyState !== WebSocket.OPEN
        || customer?.socket.readyState !== WebSocket.OPEN) return;
      const otherPeer = peer.role === "technician" ? customer : technician;
      send(otherPeer.socket, parsed.data);
    };

    authTimeout = setTimeout(() => fail("authentication_timeout"), AUTH_TIMEOUT_MS);
    authTimeout.unref();
    socket.on("message", (data, isBinary) => {
      queue = queue.then(() => handleMessage(data, isBinary)).catch(() => {
        console.error("websocket_message_failed");
        fail("internal_server_error", 1011);
      });
    });
    socket.on("error", () => {
      console.error("websocket_connection_failed");
    });
    socket.on("close", () => {
      if (authTimeout) clearTimeout(authTimeout);
      if (!peer || !sessionId) return;
      const room = rooms.get(sessionId);
      if (room?.peers.get(peer.role)?.socket === socket) {
        room.peers.delete(peer.role);
        if (room.peers.size === 0) {
          rooms.delete(sessionId);
          if (room.expiryTimer) clearTimeout(room.expiryTimer);
          return;
        }
        for (const remaining of room.peers.values()) {
          send(remaining.socket, { type: "participant_disconnected", role: peer.role });
        }
      }
    });
  });

  const sessionCheckTimer = setInterval(() => {
    for (const sessionId of rooms.keys()) {
      void validateRoom(sessionId).catch(() => {
        console.error("websocket_session_check_failed");
        notifyAndCloseRoom(sessionId, "unavailable");
      });
    }
  }, SESSION_CHECK_INTERVAL_MS);
  sessionCheckTimer.unref();
}
