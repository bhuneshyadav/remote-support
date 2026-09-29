import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { User } from "oidc-client-ts";
import { isLocalDevBypassEnabled, setLocalDevAccessToken, userManager } from "./auth";
import { api, type Session } from "./api";
import { ScreenViewer } from "./ScreenViewer";

type CreatedSession = Session & { code: string };

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function statusLabel(status: Session["status"]) {
  return status.replaceAll("_", " ");
}

function technicianDisplayName(user: User) {
  if (typeof user.profile.name === "string") return user.profile.name;
  if (typeof user.profile.email === "string") return user.profile.email;
  return "Technician";
}

export function App() {
  const location = useLocation();
  if (location.pathname === "/customer") return <CustomerJoin />;
  return <TechnicianDashboard />;
}

function TechnicianDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [purpose, setPurpose] = useState("");
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (window.location.pathname === "/auth/callback") {
      userManager.signinRedirectCallback().then((signedIn) => {
        setUser(signedIn);
        navigate("/", { replace: true });
      }).catch(() => setError("Sign-in could not be completed."));
      return;
    }
    const skipLogin = isLocalDevBypassEnabled();
    if (skipLogin) {
      void setLocalDevAccessToken().then(() => {
        userManager.getUser().then(setUser).catch(() => setError("Could not restore sign-in. Please sign in again."));
      }).catch(() => setError("The local-dev bypass is disabled."));
      return;
    }
    userManager.getUser().then(setUser).catch(() => setError("Could not restore sign-in. Please sign in again."));
  }, [navigate]);

  const loadSessions = useCallback(async (accessToken: string) => {
    const result = await api<{ sessions: Session[] }>("/api/v1/sessions", {}, accessToken);
    setSessions(result.sessions);
  }, []);

  useEffect(() => {
    if (!user?.access_token) return;
    loadSessions(user.access_token).catch(() => setError("Could not load sessions."));
    const timer = window.setInterval(() => {
      loadSessions(user.access_token).catch(() => setError("Live refresh failed. Reload the page to retry."));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [user, loadSessions]);

  async function createSession(event: React.FormEvent) {
    event.preventDefault();
    if (!user?.access_token || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<CreatedSession>("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({ purpose }),
      }, user.access_token);
      setCreated(result);
      setPurpose("");
      await loadSessions(user.access_token);
    } catch {
      setError("Could not create the session. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function endSession(session: Session) {
    if (!user?.access_token || !window.confirm("End this support request?")) return;
    try {
      await api(`/api/v1/sessions/${encodeURIComponent(session.id)}/end`, {
        method: "POST",
        body: JSON.stringify({ reason: "technician_request" }),
      }, user.access_token);
      await loadSessions(user.access_token);
    } catch {
      setError("Could not end the session. Refresh and try again.");
    }
  }

  if (window.location.pathname === "/auth/callback") {
    return <main className="panel"><p role="status">Completing secure sign-in…</p>{error && <p role="alert">{error}</p>}</main>;
  }

  if (!user) {
    return (
      <main className="panel">
        <p className="eyebrow">REMOTE SUPPORT</p>
        <h1>Technician sign in</h1>
        <p>Sign in through your organization to create a support request.</p>
        <button
          onClick={() => {
            if (import.meta.env.VITE_ALLOW_LOCAL_DEV_BYPASS !== "true") {
              setError("Local-dev bypass is disabled. Configure VITE_ALLOW_LOCAL_DEV_BYPASS=true to continue.");
              return;
            }
            void setLocalDevAccessToken().then(() => {
              userManager.getUser().then(setUser).catch(() => setError("Could not restore sign-in. Please sign in again."));
            }).catch(() => setError("Could not create the local technician session."));
          }}
        >
          Continue to sign in
        </button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <div><p className="eyebrow">REMOTE SUPPORT</p><h1>Technician dashboard</h1></div>
        <div className="identity">{technicianDisplayName(user)}<button className="secondary" onClick={() => void userManager.signoutRedirect()}>Sign out</button></div>
      </header>
      <section className="panel">
        <h2>Create a support request</h2>
        <p>The customer must approve the request in the Windows agent, separately allow screen viewing, and separately approve any remote input. The customer can stop either capability at any time.</p>
        <form className="create-form" onSubmit={createSession}>
          <label htmlFor="purpose">What do you need help with?</label>
          <input id="purpose" required minLength={3} maxLength={240} value={purpose} onChange={(event) => setPurpose(event.target.value)} />
          <button disabled={busy}>{busy ? "Creating…" : "Create request"}</button>
        </form>
        {created && (
          <div className="created" role="status">
            <h3>Share this code with the customer</h3>
            <p className="code">{created.code}</p>
            <p>Expires {formatDate(created.expiresAt)}. The code is shown once and cannot be recovered later.</p>
            <button className="secondary" onClick={() => void navigator.clipboard.writeText(created.code).catch(() => setError("Clipboard access was denied. Select and copy the code manually."))}>Copy code</button>
            <button className="secondary" onClick={() => setCreated(null)}>Dismiss code</button>
          </div>
        )}
      </section>
      {error && <p role="alert" className="error">{error}</p>}
      <section className="panel">
        <h2>Sessions</h2>
        <div className="session-list">
          {sessions.map((session) => (
            <article className="session" key={session.id}>
              <div><h3>{session.purpose}</h3><p>{statusLabel(session.status)} · Expires {formatDate(session.expiresAt)}</p></div>
              <div className="session-actions">
                {session.status === "approved" && (
                  <button
                    disabled={!user.access_token || viewingSessionId === session.id}
                    onClick={() => setViewingSessionId(session.id)}
                  >
                    {viewingSessionId === session.id ? "Viewer open" : "Connect to screen"}
                  </button>
                )}
                {["waiting_for_customer", "awaiting_approval", "approved"].includes(session.status) && <button className="danger" onClick={() => void endSession(session)}>End request</button>}
              </div>
            </article>
          ))}
          {sessions.length === 0 && <p>No sessions yet.</p>}
        </div>
      </section>
      {viewingSessionId && user.access_token && sessions.some((session) => session.id === viewingSessionId && session.status === "approved") && (
        <ScreenViewer
          key={viewingSessionId}
          sessionId={viewingSessionId}
          token={user.access_token}
          onDisconnect={() => setViewingSessionId(null)}
        />
      )}
    </main>
  );
}

function CustomerJoin() {
  const [code, setCode] = useState("");
  const [details, setDetails] = useState<{ purpose: string; organizationName: string; technicianName: string; expiresAt: string; status: string } | null>(null);
  const [decisionToken, setDecisionToken] = useState("");
  const [customerToken, setCustomerToken] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ decisionToken: string; customerToken: string; session: NonNullable<typeof details> }>("/api/v1/customer/sessions/join", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setDecisionToken(result.decisionToken);
      setCustomerToken(result.customerToken);
      setDetails(result.session);
    } catch {
      setError("That code is invalid or has expired. Check it with your technician and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ status: string }>("/api/v1/customer/sessions/decision", {
        method: "POST",
        body: JSON.stringify({ decisionToken, decision }),
      });
      setStatus(result.status);
      if (result.status !== "approved") {
        setCustomerToken("");
      }
      setDetails(null);
      setDecisionToken("");
    } catch {
      setError("The request changed or expired. Ask your technician to create a new request.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!customerToken || !status) return;
    let mounted = true;
    const refresh = async () => {
      try {
        const result = await api<{ status: string }>("/api/v1/customer/sessions/status", {
          method: "POST",
          body: JSON.stringify({ customerToken }),
        });
        if (mounted) {
          setStatus(result.status);
          if (["ended", "rejected", "expired"].includes(result.status)) {
            setCustomerToken("");
          }
        }
      } catch {
        if (mounted) setError("Could not refresh the support request status.");
      }
    };
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [customerToken, status]);

  async function endRequest() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ status: string }>("/api/v1/customer/sessions/end", {
        method: "POST",
        body: JSON.stringify({ customerToken }),
      });
      setStatus(result.status);
      setCustomerToken("");
    } catch {
      setError("Could not end the request. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="panel customer-panel">
      <p className="eyebrow">CUSTOMER CONSENT</p>
      <h1>Join a support request</h1>
      {!details && !status && (
        <form className="create-form" onSubmit={join}>
          <label htmlFor="code">Connection code</label>
          <input id="code" autoComplete="off" required maxLength={16} value={code} onChange={(event) => setCode(event.target.value)} />
          <button disabled={busy}>{busy ? "Checking…" : "Continue"}</button>
        </form>
      )}
      {details && (
        <div className="consent">
          <h2>Support request from {details.organizationName}</h2>
          <p><strong>Technician:</strong> {details.technicianName}</p>
          <p><strong>Request:</strong> {details.purpose}</p>
          <p><strong>Expires:</strong> {formatDate(details.expiresAt)}</p>
          <p className="notice">This browser approval only confirms the request; it does not connect a device. For screen support, enter the code in the Windows agent. Screen viewing and remote control require separate approvals there.</p>
          <div className="actions">
            <button disabled={busy} onClick={() => void decide("approve")}>Allow request</button>
            <button className="danger" disabled={busy} onClick={() => void decide("reject")}>Reject</button>
          </div>
        </div>
      )}
      {status && (
        <div role="status">
          <p>Request {status.replaceAll("_", " ")}.</p>
          {status === "approved" && <button className="danger" disabled={busy} onClick={() => void endRequest()}>End request</button>}
          {["ended", "rejected", "expired"].includes(status) && <button className="secondary" onClick={() => { setStatus(""); setCode(""); setCustomerToken(""); }}>Done</button>}
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
    </main>
  );
}
