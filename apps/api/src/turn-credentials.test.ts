import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTurnCredentials } from "./turn-credentials.js";

describe("TURN REST credentials", () => {
  it("issues short-lived coturn credentials bound to a session", () => {
    const now = new Date("2026-09-28T00:00:00.000Z");
    const secret = "local-test-shared-secret-with-more-than-32-bytes";
    const result = createTurnCredentials(
      "support-session-123",
      ["turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"],
      secret,
      now,
      300,
    );
    const expectedUsername = `${Math.floor(now.getTime() / 1000) + 300}:support-session-123`;
    const expectedCredential = createHmac("sha1", secret).update(expectedUsername).digest("base64");

    expect(result).toEqual({
      urls: ["turn:turn.example.test:3478?transport=udp", "turns:turn.example.test:5349?transport=tcp"],
      username: expectedUsername,
      credential: expectedCredential,
    });
  });

  it("rejects invalid configuration and excessive credential lifetimes", () => {
    expect(() => createTurnCredentials("s", ["turn:host"], "weak-secret")).toThrow();
    expect(() => createTurnCredentials("s", [], "s".repeat(32))).toThrow();
    expect(() => createTurnCredentials("s", ["turn:host"], "s".repeat(32), new Date(), 3600)).toThrow();
  });
});
