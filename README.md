# Remote Support

Windows-first, attended remote-support application. Implemented pieces include technician sign-in (OIDC), short-lived connection codes, customer approval/rejection, audit events and expiration, authenticated WebSocket signaling, customer-controlled screen sharing, short-lived TURN credentials, and a browser-side WebRTC viewer.

Remote input/control is not implemented. The customer must explicitly approve the request and separately start screen sharing in the Windows agent. Do not expose a deployment publicly until its domain, HTTPS, OIDC provider, TURN networking, secrets, and technician provisioning are configured and reviewed.

## Workspace

- `apps/web`: React + TypeScript technician dashboard and customer approval page.
- `apps/api`: Express REST API, OIDC JWT validation, session lifecycle, audit persistence, expiry worker, and authenticated WebSocket signaling at `/api/v1/ws`. Screen-description signaling is relayed only after customer screen-view consent; TURN credentials are short-lived.
- `apps/agent`: Windows WPF customer client for joining requests, giving consent, and publishing the screen after the customer starts sharing.
- `apps/web`: React + TypeScript technician dashboard, customer request approval page, and technician-side WebRTC viewer. Remote input/control is not implemented.
- `packages/contracts`: shared Zod API, signaling, and remote-control message schemas.
- `apps/api/prisma`: PostgreSQL schema and initial migration.
- `infra/compose.yaml`: local PostgreSQL for development only.
- `infra/compose.production.yaml`, `infra/api.Dockerfile`, `infra/web.Dockerfile`, and `infra/Caddyfile.example`: Linux VPS deployment starting point with HTTPS, PostgreSQL, API, web UI, and TURN relay.
- `plan.md`: full architecture, later phases, security boundaries, and acceptance gates.

## Prerequisites

- Node.js LTS and npm.
- Docker Desktop (for the local PostgreSQL service) or Docker Engine with Compose on a Linux VPS.
- An OIDC provider configured with a single-page application client for the dashboard and an API audience for this service. Require MFA for technician accounts.

## Local setup (Windows PowerShell)

1. Install dependencies from the repository root:

   ```powershell
   npm.cmd install
   ```

2. Start the local database:

   ```powershell
   docker compose -f infra\compose.yaml up -d postgres turn
   ```

   The checked-in database password is for local development only. Never reuse it outside a developer machine.

3. Copy `apps\api\.env.example` to `apps\api\.env` and fill in the real OIDC issuer, audience, JWKS URL, and a randomly generated HMAC secret of at least 32 bytes. Copy `apps\web\.env.example` to `apps\web\.env` and set the matching dashboard OIDC authority, client ID, and API audience (`resource` claim). Configure the OIDC client callback URL as `http://localhost:5173/auth/callback` and its allowed origin as `http://localhost:5173`.

4. Set up the database:

   ```powershell
   npm.cmd run db:generate
   npm.cmd run db:migrate
   ```

   For a deployment pipeline, apply checked-in migrations with `npm.cmd run db:deploy`; do not use `prisma migrate dev` against production.

5. Provision the first technician in the database using the exact `sub` claim from the OIDC provider and an organization record. Provisioning is intentionally an administrative operation; the API does not automatically grant access to arbitrary authenticated accounts.

6. Run the API and web app:

   ```powershell
   npm.cmd run dev
   ```

   Open `http://localhost:5173/` as the technician. Open `http://localhost:5173/customer` for the customer code-entry and consent flow.

7. Build and run the available tests:

   ```powershell
   npm.cmd run build
   npm.cmd test
   ```

8. Build the Windows customer agent on Windows:

   ```powershell
   dotnet build apps\agent\RemoteSupportAgent.csproj
   ```

   Set `REMOTE_SUPPORT_API_BASE_URL` to the deployed HTTPS API origin before launching the agent. Plain HTTP is accepted only for localhost development.

## Public deployment (Linux VPS)

The development address `localhost` and a private Wi-Fi IP are not reachable by customers on arbitrary networks. Public access requires a Linux VPS with a public IP, a domain pointed at that IP, and HTTPS. Do not expose the Windows development PC or PostgreSQL port to the internet.

1. Configure the domain's DNS A record to the VPS public IP. If using IPv6, ensure the VPS and firewall are configured for it too.
2. Copy `infra/production.env.example` to `infra/production.env` on the VPS. Set the domain, VPS public/private IPs used by coturn, fresh random secrets, and real OIDC issuer, API audience, JWKS URL, SPA client ID, and dashboard authority. Generate unique 32-byte hex secrets with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep `infra/production.env` private and out of source control.
3. In the OIDC provider, allow the callback `https://<your-domain>/auth/callback` and web origin `https://<your-domain>`. Provision technician records using the exact OIDC `sub` claim; the public deployment explicitly disables the local login bypass.
4. Open TCP ports 80 and 443 and UDP ports 3478 and 49160-49200 in the VPS firewall/security group. The TURN service uses Linux host networking and needs the configured public/private IP mapping for relay candidates. Do not expose PostgreSQL or the API port directly.
5. From the repository root on the VPS, build and start the stack:

   ```sh
   docker compose --env-file infra/production.env -f infra/compose.production.yaml up -d --build
   ```

   The API applies checked-in Prisma migrations at startup. Caddy obtains and renews the HTTPS certificate after DNS and firewall access are correct. Check logs with `docker compose --env-file infra/production.env -f infra/compose.production.yaml logs -f api caddy turn`.
6. Share `https://<your-domain>/customer` for browser-based request approval. For screen sharing, the customer must also run the Windows agent configured with `REMOTE_SUPPORT_API_BASE_URL=https://<your-domain>`, enter the technician's code there, approve the request, and explicitly start sharing. The browser page alone does not install or launch the Windows agent.

This is a deployment template, not a live public service: a domain, VPS, OIDC tenant, valid TURN IP mapping, backup/monitoring plan, and signed Windows agent release still need to be supplied and configured. The Windows agent is not code-signed by this project; do not distribute an unsigned executable as a trusted installer.

## Vercel frontend with a separate backend

Vercel can host the Vite frontend and Supabase can host PostgreSQL, but this application still needs a separate always-on Linux host for its Express API and UDP TURN relay. The signaling service keeps active WebRTC rooms in process memory, so do not deploy the current API as Supabase Edge Functions or scale it horizontally without moving that room state to shared storage. Vercel Functions support WebSockets only for a function's maximum duration and do not provide the single persistent process this signaling implementation needs.

1. Import the repository into Vercel with the repository root as the project root. `vercel.json` builds the shared contracts and web workspace and rewrites browser routes such as `/customer` to the SPA.
2. Set these Vercel **Production** environment variables, then redeploy:
   - `VITE_API_BASE_URL=https://<your-api-domain>`
   - `VITE_ALLOW_LOCAL_DEV_BYPASS=false`
   - `VITE_OIDC_AUTHORITY`, `VITE_OIDC_CLIENT_ID`, and `VITE_OIDC_API_AUDIENCE` from the configured OIDC SPA/API.
3. Create a Supabase project and a dedicated Prisma database user with the privileges required by Prisma migrations. On the Supabase **Connect** page, use the **Session pooler** connection string (port `5432`) for an IPv4 VPS; URL-encode reserved characters in its password. Copy `infra/vercel-backend.env.example` to `infra/vercel-backend.env` on a Linux VPS. Set `DATABASE_URL`, `API_DOMAIN`, the exact production Vercel web origin (custom domain or stable `*.vercel.app` origin), TURN public/private IPs, fresh secrets, and the real OIDC API settings. Do not put the database URL or its password in Vercel's frontend environment variables.
4. In the OIDC provider, allow `https://<your-vercel-domain>/auth/callback` and the exact Vercel web origin. Provision the technician with the provider's exact `sub`.
5. Open TCP ports 80/443 and UDP ports 3478 and 49160-49200 on the VPS. Deploy the API/relay stack; PostgreSQL remains managed by Supabase:

   ```sh
   docker compose --env-file infra/vercel-backend.env -f infra/compose.vercel-backend.yaml up -d --build
   ```

   Caddy terminates HTTPS for the API subdomain, and the API is configured to trust only its one reverse-proxy hop for client-IP rate limiting. Keep a single API instance until signaling room state is moved to shared storage.
6. Share `https://<your-vercel-domain>/customer` for browser request approval. Screen sharing additionally requires the customer to run the Windows agent, enter the code, approve the request, and explicitly start sharing. Build a self-contained Windows package configured for the public API with:

   ```powershell
   .\apps\agent\publish.ps1 -SupportApiBaseUrl https://<your-api-domain>
   ```

   The script creates an unsigned ZIP under `artifacts\`; transfer it only over a trusted channel. The project does not currently publish a signed, automatic customer download link.

## Configuration and operational notes

- The API validates required settings at startup; see `apps/api/.env.example`.
- API endpoints are served on port 3001 by default. The web app uses same-origin API requests by default; set `VITE_API_BASE_URL` only when the API is hosted on a different origin.
- Session codes are shown once to the technician and stored only as HMAC hashes. The customer decision and session tokens are also stored as hashes.
- Pending sessions expire after 10 minutes by default. Approval extends the session to the configured maximum lifetime (60 minutes by default).
- Technician records must be provisioned with an OIDC subject, organization UUID, display name, and role. MFA is a responsibility of the configured OIDC provider.
- `infra/compose.yaml` is development-only. The separate production Compose stack is for a Linux VPS and still requires operator-managed secrets, backups, monitoring, and correct public TURN relay addressing/capacity.
- TURN REST credentials use a separate shared secret and expire quickly. For local development, set `TURN_SHARED_SECRET` to the same value as the coturn compose default and use `TURN_URLS=turn:localhost:3478?transport=udp`. The loopback-bound Compose TURN service is only a development starting point; Docker Desktop/NAT may require an external-IP mapping to make relayed candidates reachable. For deployment, set public `TURN_URLS`, inject the same strong secret into API and coturn from a secret manager, and configure TLS certificates, `external-ip` when behind NAT, and matching relay ranges/firewall rules. Keep coturn restricted to expected relay ports; the checked-in example values are not for deployment.
- When the API runs in a container behind the example Caddy reverse proxy, configure `HOST=0.0.0.0` inside that container so the proxy can reach it on the private container network. Keep the service private behind the TLS proxy and firewall; do not expose the API container port directly to the public internet.
- Dashboard session status is polled. The authenticated WebSocket signaling endpoint uses a first-message authentication exchange; credentials are not placed in the WebSocket URL.
- The Windows consent client shares the customer join/approve/reject/end API. It displays the organization and technician before asking permission and attempts to revoke an active request when its window closes.
- Browser-side WebRTC, authenticated signaling, consent-gated SDP/ICE relay, and short-lived TURN credential delivery are implemented. Remote input/control is not implemented and must not be treated as functional remote control.
- Automated build/test commands are provided above, but a passing build, full integration test, production TURN deployment, signed agent release, and production security/operations review are not established by this project.

## Security boundary

Do not add unattended access, hidden persistence, credential/keystroke collection, or control without explicit consent. Keep each future capability separately authorized and disabled until its acceptance gate in `plan.md` is met.
