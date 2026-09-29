import { afterEach, describe, expect, it, vi } from "vitest";
import { api, describeApiError } from "./api";

describe("api client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends bearer credentials without cookies and returns JSON", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    const result = await api<{ status: string }>('/api/v1/me', {}, "access-token");

    expect(result).toEqual({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/me"),
      expect.objectContaining({
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("surfaces API errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
    );
    await expect(api("/api/v1/customer/sessions/join")).rejects.toThrow("rate_limited");
  });

  it("rejects successful responses with invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json", { status: 200 }));
    await expect(api("/api/v1/me")).rejects.toThrow("invalid_server_response");
  });

  it("explains when the frontend is pointed at a non-API URL", () => {
    expect(describeApiError(new Error("invalid_server_response"))).toContain("VITE_API_BASE_URL");
  });

  it("explains when the API rejects an unprovisioned technician", () => {
    expect(describeApiError(new Error("technician_not_provisioned"))).toContain("provisioned as a technician");
  });
});
