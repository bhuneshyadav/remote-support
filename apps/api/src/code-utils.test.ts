import { describe, expect, it } from "vitest";
import { digestSecret, generateConnectionCode, normalizeConnectionCode } from "./code-utils.js";

describe("connection code utilities", () => {
  it("generates eight characters from the unambiguous 32-character alphabet", () => {
    const allowed = /^[2-9A-HJ-NP-Z]{8}$/;
    for (let index = 0; index < 100; index += 1) {
      expect(generateConnectionCode()).toMatch(allowed);
    }
  });

  it("normalizes case, spaces, and hyphens", () => {
    expect(normalizeConnectionCode("ab-cd 23ef")).toBe("ABCD23EF");
  });

  it("uses a keyed digest and does not return the source secret", () => {
    const first = digestSecret("ABCDEFGH", "test-secret-key-that-is-long-enough");
    const same = digestSecret("ABCDEFGH", "test-secret-key-that-is-long-enough");
    const differentKey = digestSecret("ABCDEFGH", "another-test-secret-key-long-enough");
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(same);
    expect(first).not.toBe("ABCDEFGH");
    expect(first).not.toBe(differentKey);
  });
});
