const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const ICE_SERVERS_JSON = import.meta.env.VITE_ICE_SERVERS;

export function getSignalingUrl(apiBase = API_BASE): string {
  const base = new URL(apiBase, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("The API URL must use HTTP or HTTPS.");
  }
  const protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${base.host}/api/v1/ws`;
}

export function getIceServers(json = ICE_SERVERS_JSON): RTCIceServer[] {
  if (!json?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("VITE_ICE_SERVERS must contain valid JSON.");
  }

  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new Error("VITE_ICE_SERVERS must be an array of at most 8 ICE servers.");
  }

  return parsed.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`ICE server ${index + 1} must be an object.`);
    }

    const server = entry as Record<string, unknown>;
    const urls = server.urls;
    const normalizedUrls = typeof urls === "string" ? [urls] : urls;
    if (
      !Array.isArray(normalizedUrls) ||
      normalizedUrls.length < 1 ||
      normalizedUrls.length > 8 ||
      normalizedUrls.some((url) => typeof url !== "string" || !/^(stun|stuns|turn|turns):.{1,512}$/i.test(url))
    ) {
      throw new Error(`ICE server ${index + 1} has invalid URLs.`);
    }

    if (server.username !== undefined || server.credential !== undefined) {
      throw new Error("VITE_ICE_SERVERS may contain public STUN URLs only; credentials must come from authenticated signaling.");
    }

    if (normalizedUrls.some((url) => !/^stuns?:/i.test(url as string))) {
      throw new Error("VITE_ICE_SERVERS may contain public STUN URLs only; TURN credentials must come from authenticated signaling.");
    }

    return { urls: normalizedUrls as string[] };
  });
}
