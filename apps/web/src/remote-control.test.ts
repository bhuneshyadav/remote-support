import { describe, expect, it } from "vitest";
import {
  createRemoteControlMessage,
  getNormalizedVideoPoint,
  isAllowedRemoteKey,
} from "./remote-control";

describe("remote control helpers", () => {
  it("normalizes points to the displayed video rather than the letterboxed element", () => {
    const rect = { left: 0, top: 0, width: 400, height: 400 };
    expect(getNormalizedVideoPoint(200, 100, rect, 1600, 900)).toEqual({ x: 0.5, y: 0.5 });
    expect(getNormalizedVideoPoint(200, 20, rect, 1600, 900)).toBeNull();
  });

  it("rejects non-finite and out-of-bounds coordinates", () => {
    const rect = { left: 10, top: 20, width: 400, height: 225 };
    expect(getNormalizedVideoPoint(Number.NaN, 40, rect, 1600, 900)).toBeNull();
    expect(getNormalizedVideoPoint(500, 40, rect, 1600, 900)).toBeNull();
  });

  it("allows safe named keys and serializes only schema-approved events", () => {
    expect(isAllowedRemoteKey("KeyA")).toBe(true);
    expect(isAllowedRemoteKey("OSLoginCredential")).toBe(false);
    expect(createRemoteControlMessage({ type: "pointer_move", x: 0.2, y: 0.7 })).toBe(
      '{"type":"pointer_move","x":0.2,"y":0.7}',
    );
    expect(createRemoteControlMessage({ type: "pointer_move", x: 2, y: 0 })).toBeNull();
  });
});
