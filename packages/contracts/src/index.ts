import { z } from "zod";

export const sessionStatusSchema = z.enum([
  "waiting_for_customer",
  "awaiting_approval",
  "approved",
  "rejected",
  "ended",
  "expired",
]);

export const sessionIdSchema = z.string().uuid();

export const createSessionSchema = z.object({
  purpose: z.string().trim().min(3).max(240),
});

export const joinSessionSchema = z.object({
  code: z.string().trim().min(6).max(16),
});

export const customerDecisionSchema = z.object({
  decisionToken: z.string().min(32).max(256),
  decision: z.enum(["approve", "reject"]),
});

export const customerAccessSchema = z.object({
  customerToken: z.string().min(32).max(256),
});

export const signalingAuthSchema = z.object({
  type: z.literal("auth"),
  sessionId: sessionIdSchema,
  token: z.string().min(32).max(4096),
});

const webSocketSignalingAuthSchema = signalingAuthSchema.strict();

export const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(60_000),
});

const boundedSessionDescriptionSchema = sessionDescriptionSchema.strict();

export const iceCandidateSchema = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(1024).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

const boundedIceCandidateSchema = iceCandidateSchema.strict();

export const webSocketSignalingMessageSchema = z.discriminatedUnion("type", [
  webSocketSignalingAuthSchema,
  z.object({
    type: z.literal("offer"),
    payload: boundedSessionDescriptionSchema.extend({ type: z.literal("offer") }).strict(),
  }).strict(),
  z.object({
    type: z.literal("answer"),
    payload: boundedSessionDescriptionSchema.extend({ type: z.literal("answer") }).strict(),
  }).strict(),
  z.object({ type: z.literal("candidate"), payload: boundedIceCandidateSchema }).strict(),
  z.object({ type: z.literal("grant_viewing"), granted: z.boolean() }).strict(),
]);

export const remoteControlEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pointer_move"),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  }).strict(),
  z.object({
    type: z.literal("pointer_button"),
    button: z.enum(["left", "right", "middle"]),
    pressed: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("pointer_scroll"),
    deltaX: z.number().int().min(-1200).max(1200),
    deltaY: z.number().int().min(-1200).max(1200),
  }).strict(),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    code: z.string().regex(/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Enter|Escape|Tab|Backspace|Delete|Arrow(Up|Down|Left|Right)|Home|End|Page(Up|Down)|Space|Shift(Left|Right)?|Control(Left|Right)?|Alt(Left|Right)?|Meta(Left|Right)?)$/),
  }).strict(),
]);

export const remoteControlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("control_request") }).strict(),
  z.object({ type: z.literal("control_decision"), granted: z.boolean() }).strict(),
  z.object({ type: z.literal("control_revoke") }).strict(),
  remoteControlEventSchema,
]);

export const signalingMessageSchema = z.discriminatedUnion("type", [
  signalingAuthSchema,
  z.object({ type: z.literal("offer"), payload: sessionDescriptionSchema.extend({ type: z.literal("offer") }) }),
  z.object({ type: z.literal("answer"), payload: sessionDescriptionSchema.extend({ type: z.literal("answer") }) }),
  z.object({ type: z.literal("candidate"), payload: iceCandidateSchema }),
  z.object({ type: z.literal("grant_viewing"), granted: z.boolean() }),
]);

export const signalingServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("authenticated"),
    role: z.enum(["technician", "customer"]),
    screenViewingGranted: z.boolean().optional(),
  }),
  z.object({ type: z.literal("auth_ok"), role: z.enum(["technician", "customer"]), screenViewingGranted: z.boolean() }),
  z.object({ type: z.literal("participant_connected"), role: z.enum(["technician", "customer"]) }),
  z.object({ type: z.literal("participant_disconnected"), role: z.enum(["technician", "customer"]) }),
  z.object({ type: z.literal("status"), status: z.string().max(64) }),
  z.object({
    type: z.literal("ice_servers"),
    servers: z.array(z.object({
      urls: z.union([
        z.string().regex(/^(stun|stuns|turn|turns):.{1,512}$/),
        z.array(z.string().regex(/^(stun|stuns|turn|turns):.{1,512}$/)).min(1).max(8),
      ]),
      username: z.string().max(512).optional(),
      credential: z.string().max(1024).optional(),
    })).max(8),
  }),
  z.object({ type: z.literal("offer"), payload: sessionDescriptionSchema.extend({ type: z.literal("offer") }) }),
  z.object({ type: z.literal("answer"), payload: sessionDescriptionSchema.extend({ type: z.literal("answer") }) }),
  z.object({ type: z.literal("candidate"), payload: iceCandidateSchema }),
  z.object({ type: z.literal("error"), error: z.string().max(128) }),
]);

export const endSessionSchema = z.object({
  reason: z.enum(["technician_request", "customer_request"]).optional(),
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionSchema>;
export type JoinSessionRequest = z.infer<typeof joinSessionSchema>;
export type CustomerDecisionRequest = z.infer<typeof customerDecisionSchema>;

export interface SessionSummary {
  id: string;
  purpose: string;
  status: SessionStatus;
  createdAt: string;
  expiresAt: string;
  technicianName: string;
}
