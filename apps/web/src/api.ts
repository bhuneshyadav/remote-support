const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export interface Session {
  id: string;
  purpose: string;
  status: "waiting_for_customer" | "awaiting_approval" | "approved" | "rejected" | "ended" | "expired";
  createdAt: string;
  expiresAt: string;
  technicianName: string;
}

export async function api<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });

  let body: { error?: string };
  try {
    body = await response.json() as { error?: string };
  } catch {
    throw new Error("invalid_server_response");
  }

  if (!response.ok) throw new Error(body.error ?? `request_failed_${response.status}`);
  return body as T;
}
