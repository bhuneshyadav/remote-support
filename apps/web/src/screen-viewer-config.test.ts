import { describe, expect, it } from "vitest";
import { getIceServers, getSignalingUrl } from "./screen-viewer-config";

describe("screen viewer configuration", () => {
  it("derives the WebSocket scheme and fixed API endpoint from the API origin", () => {
    expect(getSignalingUrl("http://localhost:3001/prefix?token=ignored")).toBe("ws://localhost:3001/api/v1/ws");
    expect(getSignalingUrl("https://api.example.test/base")).toBe("wss://api.example.test/api/v1/ws");
    expect(getSignalingUrl("/")).toBe("ws://localhost/api/v1/ws");
  });

  it("uses no default ICE servers and accepts optional public STUN-only configuration", () => {
    expect(getIceServers("")).toEqual([]);
    expect(getIceServers('[{"urls":["stun:stun.example.test","stuns:stun.example.test"]}]')).toEqual([
      { urls: ["stun:stun.example.test", "stuns:stun.example.test"] },
    ]);
  });

  it("rejects malformed ICE configuration", () => {
    expect(() => getIceServers("{")).toThrow("valid JSON");
    expect(() => getIceServers('[{"urls":"https://invalid.example.test"}]')).toThrow("invalid URLs");
    expect(() => getIceServers('[{"urls":"turn:turn.example.test","username":"user","credential":"secret"}]')).toThrow("public STUN URLs only");
    expect(() => getIceServers('[{"urls":"turn:turn.example.test"}]')).toThrow("public STUN URLs only");
  });
});
