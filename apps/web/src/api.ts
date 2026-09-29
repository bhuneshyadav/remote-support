const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

export interface Session {
  id: string;
  purpose: string;
  status: "waiting_for_customer" | "awaiting_approval" | "approved" | "rejected" | "ended" | "expired";
  createdAt: string;
  expiresAt: string;
  technicianName: string;
}

export function describeApiError(error: unknown): string {
  if (!(error instanceof Error)) return "An unexpected error occurred.";

  if (error.message === "invalid_server_response") {
    return "The API URL returned a non-JSON response. Set VITE_API_BASE_URL to your deployed API URL and redeploy.";
  }
  if (error instanceof TypeError) {
    return "The API could not be reached. Check VITE_API_BASE_URL, API availability, and allowed web origin.";
  }
  if (error.message === "unauthorized") {
    return "Sign-in was rejected by the API. Sign in again with your configured organization account.";
  }
  if (error.message === "technician_not_provisioned") {
    return "This account has not been provisioned as a technician in the API database.";
  }

  return error.message;
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
