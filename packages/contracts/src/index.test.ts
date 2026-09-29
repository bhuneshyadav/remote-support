import { describe, expect, it } from "vitest";
import {
  remoteControlEventSchema,
  remoteControlMessageSchema,
  signalingMessageSchema,
  signalingServerMessageSchema,
  webSocketSignalingMessageSchema,
} from "./index.js";

describe("signaling contract", () => {
  const sessionId = "bb1cc6f3-4ee0-4ad4-a534-542a53b01e18";

  it("validates the initial auth message shape", () => {
    expect(signalingMessageSchema.safeParse({
      type: "auth",
      sessionId,
      token: "a".repeat(48),
    }).success).toBe(true);
    expect(signalingMessageSchema.safeParse({
      type: "auth",
      sessionId: "not-a-uuid",
      token: "short",
    }).success).toBe(false);
  });

  it("rejects oversized session descriptions and unknown control messages", () => {
    expect(signalingMessageSchema.safeParse({
      type: "offer",
      payload: { type: "offer", sdp: "x".repeat(60_001) },
    }).success).toBe(false);
    expect(signalingMessageSchema.safeParse({
      type: "input",
      payload: { key: "A" },
    }).success).toBe(false);
  });

  it("accepts only bounded WebSocket auth and peer signaling messages", () => {
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "auth",
      sessionId,
      token: "a".repeat(48),
    }).success).toBe(true);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "offer",
      payload: { type: "offer", sdp: "v=0" },
    }).success).toBe(true);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "candidate",
      payload: { candidate: "candidate:1" },
    }).success).toBe(true);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "offer",
      payload: { type: "offer", sdp: "v=0", extra: true },
    }).success).toBe(false);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "grant_viewing",
      granted: true,
    }).success).toBe(true);
  });

  it("accepts only the documented customer viewing grant and server event envelope", () => {
    expect(signalingMessageSchema.safeParse({
      type: "grant_viewing",
      granted: true,
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "auth_ok",
      role: "customer",
      screenViewingGranted: false,
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "ice_servers",
      servers: [],
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "control_enabled",
    }).success).toBe(false);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "grant_viewing",
      granted: true,
    }).success).toBe(true);
    expect(webSocketSignalingMessageSchema.safeParse({
      type: "grant_viewing",
      granted: true,
      sessionId,
    }).success).toBe(false);
    expect(webSocketSignalingMessageSchema.safeParse({ type: "close" }).success).toBe(false);
    expect(signalingServerMessageSchema.safeParse({
      type: "authenticated",
      role: "technician",
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "authenticated",
      role: "technician",
      screenViewingGranted: false,
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "status",
      status: "viewing_revoked",
    }).success).toBe(true);
    expect(signalingServerMessageSchema.safeParse({
      type: "participant_disconnected",
      role: "customer",
    }).success).toBe(true);
  });

  it("bounds pointer input and allowlists keyboard event codes", () => {
    expect(remoteControlEventSchema.safeParse({
      type: "pointer_move",
      x: 0.5,
      y: 1,
    }).success).toBe(true);
    expect(remoteControlEventSchema.safeParse({
      type: "pointer_move",
      x: 1.1,
      y: 0,
    }).success).toBe(false);
    expect(remoteControlEventSchema.safeParse({
      type: "key",
      action: "down",
      code: "KeyA",
    }).success).toBe(true);
    expect(remoteControlEventSchema.safeParse({
      type: "key",
      action: "down",
      code: "OSLoginCredential",
    }).success).toBe(false);
    expect(remoteControlEventSchema.safeParse({
      type: "key",
      action: "down",
      code: "KeyA",
      text: "do-not-accept-raw-text",
    }).success).toBe(false);
    expect(remoteControlEventSchema.safeParse({
      type: "pointer_scroll",
      deltaX: 50000,
      deltaY: 0,
    }).success).toBe(false);
  });

  it("models a distinct remote-control consent decision", () => {
    expect(remoteControlMessageSchema.safeParse({ type: "control_request" }).success).toBe(true);
    expect(remoteControlMessageSchema.safeParse({ type: "control_decision", granted: true }).success).toBe(true);
    expect(remoteControlMessageSchema.safeParse({ type: "control_revoke" }).success).toBe(true);
    expect(remoteControlMessageSchema.safeParse({
      type: "control_decision",
      granted: true,
      automatic: true,
    }).success).toBe(false);
  });
});
