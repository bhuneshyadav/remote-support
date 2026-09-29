# Remote Support — Full Product Architecture and Delivery Plan

## Goal and scope

Deliver a Windows-first remote support product with an authenticated technician dashboard, a customer-controlled Windows agent, and short-lived, auditable sessions. A customer joins with a temporary code, sees who is requesting access, explicitly approves the requested capabilities, and can revoke access or end the session at any time.

Build and release the product in gated phases below. The Phase 1 foundation described first provides session creation, customer consent, and lifecycle management only; it does not itself provide screen sharing or remote control. Later capabilities must not be enabled until their consent, authorization, expiry, audit, and security acceptance criteria pass. This plan does not include hidden access, credential capture, or default unattended access.

## Recommended stack

| Area | Choice |
| --- | --- |
| Web UI | React, TypeScript, Vite, Tailwind CSS |
| API and real-time events | Node.js, TypeScript, REST, WebSocket |
| Database | PostgreSQL |
| Database access | Prisma ORM and checked-in migrations |
| Authentication | Managed OIDC provider for technicians; MFA required by provider policy |
| Validation | Shared request/response schemas (for example, Zod) |
| Tests | Vitest; API integration tests against PostgreSQL |
| Local development | Docker Compose for PostgreSQL; run web and API with package scripts |

Use a supported Node.js LTS release and pin dependency versions. Keep the API, UI, and shared types in one TypeScript monorepo for the first release.

## System overview

```text
Technician browser <---- HTTPS / WSS ----> Node.js API and signaling
        ^                                      |       ^
        |                                      |       | HTTPS / WSS
        | WebRTC media + DataChannel            |       |
        | (only after customer consent)          v       v
        +------------------------------> Customer Windows agent
        |                                      |
        +--------- WebRTC via STUN/TURN --------+
                                               |
                                      TLS database connection
                                               v
                                           PostgreSQL
```

The server is authoritative for identity, session transitions, code uniqueness, expiry, and audit history. WebSocket notifications are an optimization for timely dashboard updates; clients must be able to reload and retrieve the canonical session state through REST. WebRTC media and control channels are established only after the corresponding customer consent grants.

## Repository layout

```text
remote-support/
├── apps/
│   ├── web/                 # Technician dashboard and customer join/approval page
│   └── api/                 # REST API, WebSocket events, background expiry worker
│   └── agent/               # Windows customer agent (.NET; visible, consent-driven UI)
├── packages/
│   ├── contracts/           # Shared API, signaling, and event schemas
│   └── protocol/            # Versioned, validated WebRTC control-message definitions
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── infra/                   # PostgreSQL, TURN, reverse proxy, deployment definitions
├── docs/
│   ├── architecture.md
│   └── security.md
└── package.json
```

Keep provider-specific login details and database access inside the API. The browser must never connect directly to PostgreSQL or receive signing secrets.

## Phase 1 user flows

### Technician

1. Sign in through the configured OIDC provider; the API validates the issuer, audience, signature, expiry, and required technician role.
2. View active and recent sessions belonging to the technician's organization.
3. Create a support request. The API generates an unpredictable, short-lived code and returns the code, expiry, and session status.
4. Share the code with the customer out of band. Do not expose a customer session merely by guessing or enumerating IDs.
5. Receive customer-joined, approved, rejected, expired, and ended events. Reloading the dashboard restores state from REST.
6. End a session at any time.

### Customer

1. Open the customer join page and submit the code.
2. The API validates the code and expiry, then presents a clear approval screen showing the technician/organization identity, session purpose, and expiry.
3. Explicitly approve or reject. No approval is inferred from page load, inactivity, or WebSocket connection.
4. See the current status and a clear way to leave/end the request. There is no remote-control capability in this phase.

## Session lifecycle and expiry

Use these states:

```text
waiting_for_customer -> awaiting_approval -> approved -> ended
          |                    |              |
          +----> expired       +--> rejected  +--> expired
```

Terminal states are `rejected`, `ended`, and `expired`. Permit only documented transitions and perform each transition atomically. Set a short configurable lifetime for pending requests (suggested initial default: 10 minutes) and a maximum approved-session lifetime (suggested initial default: 60 minutes); make both values configuration, not client input. Expiration must be enforced when reading or mutating a session as well as by a periodic worker, so a delayed worker cannot keep an expired request usable.

Generate codes using a cryptographically secure random source with at least 40 bits of entropy (prefer 8 unambiguous uppercase alphanumeric characters). Normalize case and separators on input. Store only a keyed hash of the code; never log or persist the plaintext code. Enforce uniqueness of active code hashes with a database constraint and safely retry generation on collision. Apply rate limits to code creation and customer code attempts.

## Data model

### `organizations`

- `id` UUID primary key
- `name` text, required
- `created_at` timestamp with time zone

### `technicians`

- `id` UUID primary key, mapped to the stable OIDC subject
- `organization_id` UUID foreign key
- `display_name` text
- `role` enum (`technician`, `admin`)
- `created_at`, `updated_at` timestamps with time zone

### `support_sessions`

- `id` UUID primary key (internal identifier; not a bearer credential)
- `organization_id`, `technician_id` foreign keys
- `code_hash` byte string, nullable once no longer needed
- `status` enum matching the lifecycle above
- `purpose` text with a conservative length limit
- `created_at`, `expires_at`, `updated_at` timestamps with time zone
- `customer_label` nullable text, only if explicitly provided
- `ended_at` nullable timestamp with time zone
- optimistic concurrency field (`version`) or equivalent conditional-update mechanism

Add indexes for technician/org session lists and expiry scans. Enforce active-code uniqueness in PostgreSQL, using a partial unique index or an equivalent transactional design. Choose deletion/retention periods for expired session metadata and audit events before production deployment.

### `audit_events`

- `id` UUID primary key
- `organization_id`, `session_id` foreign keys
- `actor_type` enum (`technician`, `customer`, `system`)
- nullable `actor_id`
- `event_type` enum (created, customer_joined, approved, rejected, ended, expired)
- `occurred_at` timestamp with time zone
- structured metadata with an explicit allowlist; never include codes, tokens, secrets, or raw request bodies

Audit rows should be append-only to application roles. Record state transitions in the same database transaction as the session update.

## API outline

All endpoints use HTTPS, JSON, bounded request sizes, shared schema validation, and consistent error responses. Technician endpoints require a valid access token and organization-scoped authorization.

| Method and path | Purpose |
| --- | --- |
| `GET /api/v1/me` | Return authenticated technician profile and organization |
| `POST /api/v1/sessions` | Create a session; return one-time plaintext code, session ID, state, and expiry |
| `GET /api/v1/sessions` | List sessions in the technician's organization with pagination and filters |
| `GET /api/v1/sessions/:id` | Retrieve session state after organization/role authorization |
| `POST /api/v1/sessions/:id/end` | End an active session idempotently |
| `POST /api/v1/customer/sessions/join` | Submit a code; return a narrowly scoped, short-lived customer decision token and non-sensitive request details |
| `POST /api/v1/customer/sessions/decision` | Approve or reject using the decision token; enforce one decision and valid state |
| `GET /api/v1/customer/sessions/status` | Retrieve minimal customer-visible status using the decision token |
| `GET /api/v1/ws` | Authenticated WebSocket for authorized session status events |

Do not put bearer tokens or connection codes in URLs, query strings, analytics, or referrer-bearing links. Return generic errors for unknown, expired, and invalid codes to reduce enumeration. Do not return the stored code hash or internal authorization data.

## WebSocket events

Use authenticated, organization-scoped subscriptions. Validate origin and authorization when upgrading; do not trust client-supplied session IDs without checking access. Events carry only the session ID, new status, event time, and necessary display metadata. Revalidate permission when subscribing and on reconnect. Support reconnect with REST resynchronization; do not treat WebSocket delivery as durable.

## Security and privacy requirements

- Require TLS in deployed environments and secure cookies where cookie-based sessions are used.
- Delegate technician authentication to OIDC; require MFA and enforce short access-token lifetimes and role/organization checks.
- Protect state-changing browser requests against CSRF when using cookies; configure CORS to the exact dashboard/customer origins.
- Store only a server-keyed HMAC of each session code and use high-entropy codes with aggressive rate limits. Keep keys in deployment secret storage and support rotation.
- Rate-limit session creation, code attempts, login callbacks, and WebSocket connection/subscription attempts by appropriate identity and network signals.
- Make customer consent explicit, informed, visible, and revocable. A customer decision token is short-lived, narrowly scoped, single-purpose, and never authorizes future sessions.
- Use parameterized queries/ORM APIs, strict input validation, output encoding, security headers, and dependency scanning.
- Redact secrets and personal data from logs. Record security-relevant transitions without recording screen contents or keystrokes.
- Do not add hidden access, persistence, remote input, credential capture, or unattended-access behavior.
- Define abuse reporting, account suspension, data retention, backup, and incident-response procedures before production launch.

## Implementation sequence

1. **Foundation:** initialize the TypeScript workspace, shared contracts, formatting/linting, configuration validation, PostgreSQL development service, and migration workflow.
2. **Identity and tenancy:** integrate OIDC login, technician provisioning/organization mapping, role checks, and `/me`.
3. **Session API:** add schema/migrations, secure code generation and hashing, lifecycle transition service, audit writes, and REST tests.
4. **Customer consent:** add code entry, request details, approval/rejection, scoped decision tokens, attempt throttling, and tests for replay/expiry.
5. **Dashboard:** implement create-session, copy-code, session list/detail, status display, and end-session flows.
6. **Live status and expiry:** add authorized WebSocket updates and a periodic expiry worker; verify REST remains the source of truth.
7. **Hardening and release:** add structured redacted logs, health/readiness checks, deployment configuration, backups/retention policy, and an operational runbook.

## Phases 2–6: full product delivery

The phases below extend Phase 1; they do not replace its identity, session lifecycle, consent, audit, or expiration controls. Each phase has a separate release gate. Do not ship later-phase controls behind undocumented feature flags or enable them by default.

### Phase 2 — Windows customer agent and authenticated signaling

**Deliverable:** A signed, user-launched Windows agent that accepts the short-lived code created by the technician dashboard, identifies the requesting organization and technician, and asks for explicit customer approval. Once approved, it can maintain an authenticated session relationship with the API. This phase does not yet stream the screen or accept remote input.

#### Agent responsibilities

- Build a Windows desktop application with supported C#/.NET and Windows APIs. Keep UI, session/authentication, signaling, and future media/control adapters in separate modules.
- On launch, let the customer enter the short-lived code received from the technician. Exchange it over TLS for narrowly scoped session tokens; never treat a local device/session identifier as authorization.
- Show the request expiry, connection state, and a persistent, unmistakable session status. Identify the technician and organization before allowing approval.
- Require a deliberate Allow/Reject action for each new request. Approval is bound to the session and an explicitly declared capability set; it expires with the session and cannot authorize future connections.
- Provide a prominent one-click disconnect/revoke action and visible connected-technician identity. Close/revoke sessions on agent exit, disconnect, or expiry as defined by server policy.
- Do not install a service, enable startup persistence, hide the window, or offer unattended access in these phases. Updates must be signed and verified before a later auto-update feature is considered.

#### Signaling and identity

- Use WSS through the backend as a control/signaling channel, not as a media relay. Authenticate both technician and agent; bind messages to server-authorized session participants.
- Add explicit signaling message schemas and size/rate limits for offer, answer, ICE candidate, readiness, consent, revoke, and disconnect. Reject unexpected message types and invalid state transitions.
- Issue short-lived, session-scoped credentials to the agent and browser only after successful authorization. Do not use the human-readable join code or internal session UUID as a WebRTC credential.
- Track agent presence and heartbeat, but treat loss of heartbeat as a disconnect subject to a conservative timeout; never silently resume control after reconnect.

**Acceptance gate:** A customer can reject, revoke, or close the agent; another technician or session cannot reuse that approval; invalid/expired credentials cannot join; the technician identity and session status remain visible; and reconnect requires revalidation and renewed customer approval before any future media/control grant.

### Phase 3 — Customer screen viewing with WebRTC

**Deliverable:** A customer-approved, one-way screen stream from the agent to the technician's browser. No remote input is enabled in this phase.

- Capture only after a visible customer approval. Use Windows.Graphics.Capture or another supported Windows capture API that exposes capture indicators and respects OS permissions. Document supported Windows versions and multi-monitor behavior.
- Encode and send video peer-to-peer through WebRTC where possible. Use DTLS-SRTP-protected WebRTC media; never send screen frames through REST or persist/record them by default.
- Exchange SDP and ICE candidates using the authenticated signaling channel. Configure STUN for connectivity discovery and TURN for relay; TURN credentials must be short-lived, scoped, and minted by the backend. WebRTC media is encrypted in transit.
- Add an explicit “Screen viewing” consent grant, separate from any later control grant. Display a persistent “Screen is being shared” indicator and technician identity on the customer agent. Provide a customer stop-sharing control that immediately stops capture and closes/revokes the peer connection.
- Start without audio, clipboard, file transfer, recording, or remote input. Viewer UI must clearly show connecting/reconnecting/disconnected states and session expiry.
- Define resolution/frame-rate limits and adapt quality to bandwidth; avoid retaining frames in application logs, analytics, crash reports, or server storage.

**Acceptance gate:** No capture begins before the customer grants viewing; revocation stops capture promptly; only the authorized technician can view; reconnect cannot silently restart capture; TURN-only networks are tested; browser/agent reports and handles peer failure; and automated tests verify that screen data is not written to persistent storage.

### Phase 4 — Explicitly authorized remote input

**Deliverable:** Optional mouse and keyboard control, disabled by default and granted separately from screen viewing.

- Present a clear second consent prompt describing mouse/keyboard control and the consequences. Customer must affirmatively grant it after the viewing session is established; declining leaves screen viewing available.
- Display an always-visible remote-control indicator and technician identity. Provide a one-click revoke button plus a documented local emergency shortcut. Revocation must stop injection immediately and be recorded.
- Use an explicit, versioned, size-bounded DataChannel protocol with strict schemas and allowlisted input event types. Validate session, grant, sequence/rate, bounds, and active consent before processing every message.
- On Windows, inject only supported mouse/keyboard events through documented OS APIs. Do not expose APIs for reading keyboard state, collecting credentials, bypassing secure desktop/UAC, or controlling the OS login screen. Do not synthesize input while the control grant is absent, expired, or revoked.
- Enforce limits for pointer coordinates, event frequency, key codes, message size, and channel backpressure. Discard stale/replayed messages and close the control channel on protocol violations.
- Keep the customer able to use local input and terminate the session at all times. Do not let a technician suppress the consent UI or customer status indicator.

**Acceptance gate:** Remote input is impossible before the separate grant; revocation and session end stop it immediately; malformed/replayed/out-of-scope messages are rejected; local emergency termination works; and tests verify no credential-reading or secure-desktop path exists.

### Phase 5 — NAT traversal and production connectivity

**Deliverable:** Reliable WebRTC connection establishment across common home, mobile, enterprise NAT, firewall, and proxy conditions.

- Deploy and operate coturn in a supported topology with TLS where appropriate, restricted relay ports, bandwidth/session quotas, monitoring, and abuse controls.
- Mint time-limited TURN credentials only for authorized session participants. Avoid static shared TURN secrets in browser bundles or agent binaries.
- Prefer direct ICE paths when available and fall back to TURN relay. The signaling/API service continues to carry only control and negotiation messages, not screen media.
- Set relay policies, geographic placement, capacity targets, and cost alerts. Limit candidate exposure according to the product's privacy model and document IP-address visibility.
- Test direct, symmetric-NAT, TURN/TLS, blocked UDP, reconnect, network change, and relay exhaustion cases. Provide clear customer/technician connection diagnostics without exposing secrets.

**Acceptance gate:** A documented connectivity matrix passes on supported networks; expired TURN credentials fail; session end revokes authorization and releases relay resources; load and cost limits alert; and degraded relay service fails visibly rather than bypassing authorization.

### Phase 6 — Production security, operations, and release

**Deliverable:** A production-ready, supportable service and verifiable customer agent release process.

- Require technician MFA, role/organization-scoped access, least-privilege operations, secure token/session rotation, and administrative audit trails.
- Add abuse prevention, account/device/session revocation, rate limits, anomaly alerts, support escalation, and incident response procedures.
- Add immutable, access-controlled audit events for authentication outcomes, consent grants/revocations, session lifecycle, signaling authorization, and control enable/disable. Never record screen contents or keystrokes in audit logs.
- Define retention/deletion policies for session metadata, logs, and audit events; document backups, restoration tests, data residency, privacy notice, and customer consent wording.
- Establish threat modeling, dependency/SBOM review, vulnerability response, penetration testing, secure build/release, code signing, and reproducible release artifacts.
- Sign Windows agent installers and updates; verify publisher/signature and update integrity before installation. Roll out updates gradually with rollback support. Do not add auto-update until the update channel is operationally secured and tested.
- Add production monitoring, health/readiness checks, capacity limits, disaster recovery, service-level objectives, alert ownership, and deployment rollback procedures.
- Use staged releases (internal, pilot, general availability) with explicit go/no-go review at each stage.

**Acceptance gate:** Security review and penetration testing findings are triaged; recovery/rollback is exercised; signing and update verification are tested; retention and consent policies are approved; operational alerts are actionable; and no critical/high unresolved issue blocks launch.

## Later features (separate design and consent review)

File transfer, clipboard sharing, multiple-monitor selection, chat, session recording, remote reboot, technician teams/address books, reporting, and unattended access are not implied by approval for viewing or control. Each requires a distinct threat/privacy review, narrow capability grant, clear user interface, audit policy, and acceptance tests. Unattended access must be a separately configured product feature with strong authentication and explicit customer setup; it must not be introduced as a hidden default or as a side effect of agent installation.

## Parallel implementation and integration strategy

“Work on all phases at the same time” should mean parallel discovery and isolated implementation workstreams, not merging or releasing every capability without prerequisite gates. Keep a shared protocol/API contract and feature boundaries; integrate continuously against mocks, but enable each capability only after its predecessor's acceptance criteria pass.

Work that can proceed in parallel after the Phase 1 contracts are agreed:

1. **Dashboard and API foundation:** OIDC integration, tenancy, session lifecycle, audit schema, code handling, and technician UX.
2. **Windows agent shell:** signed-build pipeline prototype, customer-visible UI, code display, consent screens, and local disconnect behavior; use mocked server/session interfaces until Phase 2 API contracts stabilize.
3. **Protocol and WebRTC spike:** evaluate maintained .NET WebRTC options, browser interoperability, capture APIs, DataChannel schemas, and TURN requirements. Use synthetic/test content; do not enable input control or bypass the consent gate.
4. **Infrastructure and operations:** PostgreSQL deployment/migrations, WSS ingress, coturn topology, secret management, telemetry redaction, and load/connectivity test environments.
5. **Security and QA:** threat model, abuse cases, state-machine/property tests, Windows compatibility matrix, dependency/SBOM process, and consent/accessibility review.

Required integration gates:

- Agree and version API/signaling/control contracts before parallel components depend on them.
- Merge Phase 2 only after identity, consent, expiry, revocation, and audit end-to-end tests pass.
- Merge Phase 3 only after screen-view consent and capture-stop behavior pass on supported Windows versions.
- Keep Phase 4 remote input disabled until its separate grant, protocol validation, customer emergency-stop, and negative security tests pass.
- Do not declare Phase 5 complete until direct and TURN relay paths pass the connectivity matrix and resource-abuse controls.
- Do not launch Phase 6 until release signing, operational ownership, incident response, retention, and security review are complete.

## Full-product verification matrix

- **Lifecycle:** all states, expiry boundaries, retries, race conditions, and illegal transitions are tested at API, database, UI, and agent boundaries.
- **Identity/authorization:** tenant isolation, technician role, agent/session binding, short-lived credentials, reconnection, and revocation are tested negatively as well as positively.
- **Consent:** separate grants for join, screen viewing, and remote input; clear identity/capability disclosure; no implicit approval; immediate revoke/end; visible indicators; no silent reconnect.
- **Transport:** TLS/WSS and WebRTC DTLS-SRTP; valid certificate handling; expired/invalid session and TURN credentials; direct and relayed network paths.
- **Agent:** code signing, supported Windows versions, OS capture indicators, agent crash/disconnect, local emergency stop, and no service/startup persistence in the attended-access release.
- **Privacy:** no codes/tokens in URLs or logs, no screen/input persistence by default, minimal customer metadata, documented retention, and tested deletion.
- **Resilience:** API/database/WebSocket/TURN outage behavior is explicit, safe, observable, and does not bypass authorization or consent.
- **Release:** reproducible build inputs, dependency/SBOM review, staged rollout, rollback, backup restore, and incident drill.

## Test and acceptance criteria

- Unit tests cover code normalization, code generation, expiration, and every allowed/denied state transition.
- API integration tests verify technician/org authorization, customer approval/rejection, single-use decisions, idempotent end, expiry enforcement without the worker, and atomic audit records.
- Security tests verify that codes/tokens are absent from logs and list/detail responses; invalid and expired codes have non-enumerating responses; rate limits activate.
- WebSocket tests verify unauthorized subscriptions fail and reconnecting clients can resynchronize through REST.
- UI tests cover technician create/list/end and customer join/approve/reject/expired flows, including accessible keyboard interaction and clear consent text.
- A session code is shown to the technician only at creation and is not recoverable from the database.
- No session can be approved or acted upon after its expiry; no state can transition from a terminal state.
- Customer approval is required before a session enters `approved`; rejecting or ending a session prevents later approval.
- An approved Phase 1 session grants no screen-viewing or input-control capability.

## Decisions to confirm before production

- OIDC provider and technician provisioning/invitation policy.
- Whether customers identify themselves, and what minimal customer-provided metadata is retained.
- Exact pending/approved lifetimes, audit/data retention periods, and regional hosting requirements.
- Deployment topology, email/notification channel (if any), operational alerting, and support organization model.
- Legal/privacy review for consent wording and audit retention in target jurisdictions.
- Treat all production decisions above as launch gates.
