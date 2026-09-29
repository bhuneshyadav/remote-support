import { createHmac } from "node:crypto";

export interface IceServerConfig {
  urls: string[];
}

export interface TurnCredentials extends IceServerConfig {
  username: string;
  credential: string;
}

export function createTurnCredentials(
  sessionId: string,
  urls: readonly string[],
  sharedSecret: string,
  now = new Date(),
  lifetimeSeconds = 300,
): TurnCredentials {
  if (!sessionId || !urls.length || !sharedSecret || sharedSecret.length < 32) {
    throw new Error("TURN credentials require a session, configured URLs, and a strong shared secret");
  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 600) {
    throw new Error("TURN credential lifetime must be between 60 and 600 seconds");
  }

  const expiresAt = Math.floor(now.getTime() / 1000) + lifetimeSeconds;
  const username = `${expiresAt}:${sessionId}`;
  const credential = createHmac("sha1", sharedSecret).update(username).digest("base64");
  return { urls: [...urls], username, credential };
}
