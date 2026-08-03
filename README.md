# gateway-api-admin

Ops dashboard for [gateway-api](https://github.com/benjaminfkile/gateway-api) —
manage the service fleet from a browser: start/stop/restart services, roll and
roll back deploys, watch per-instance convergence live, and view logs. See the
gateway's `docs/tech-spec.md` §4.6 for the design.

Auth is Cognito with required TOTP MFA; all calls hit the gateway's `/mgmt/*`
endpoints with a bearer token.

## Stack

Vite · React · TypeScript · MUI (Material Design) · react-router ·
amazon-cognito-identity-js · axios · @microsoft/signalr · xterm · vitest

## Develop

```bash
npm install
cp .env.example .env   # fill in Cognito pool/client ids; leave API base empty to use the dev proxy
npm run dev            # proxies /mgmt to a local gateway on :5080
npm test
npm run build
```

## Configuration

All runtime config is supplied through Vite env vars (`VITE_`-prefixed, so they
are inlined into the client bundle at build time). Copy `.env.example` to `.env`
and fill them in.

| Variable                 | Required | Description                                                                                                     |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `VITE_API_BASE_URL`      | No       | Origin of the gateway's management API. Leave **empty** in dev so requests are same-origin and the dev proxy forwards `/mgmt` and `/hub`. In production set it to the gateway origin (e.g. `https://gateway.example.com`). |
| `VITE_COGNITO_POOL_ID`   | Yes      | Cognito User Pool id for the ops pool (e.g. `us-east-1_abc123`). Sign-in throws a configuration error if unset. |
| `VITE_COGNITO_CLIENT_ID` | Yes      | Cognito App Client id used to authenticate against the pool.                                                    |

### Dev proxy

`vite.config.ts` proxies `/mgmt` to `http://localhost:5080` so the browser talks
to a locally running gateway without CORS. Because `VITE_API_BASE_URL` is empty
in dev, both REST calls (`/mgmt/*`) and the SignalR hub (`/hub`) resolve
same-origin and flow through this proxy. Point it at a different gateway by
editing the proxy target.

## Test commands

The build container has no real gateway, no Cognito, and no network beyond npm.
Tests mock all HTTP with `axios-mock-adapter` and mock the auth/SignalR modules,
so the whole suite runs offline.

```bash
npm test          # run the vitest suite once (jsdom)
npm run test:watch # watch mode
npm run build     # tsc project build + vite production build
npm run lint      # oxlint
```

`src/App.test.tsx` is a router-level smoke test: with auth mocked as signed-in
and every API mocked, it navigates through each nav item and asserts the page's
heading renders, plus checks the in-shell 404 fallback.

## Features by page

- **Services** (`/`) — fleet grid of every registered service with rolled-up
  running/total counts, status chips, digest (with drift warnings), and a
  per-row action menu: start / stop (force-stop confirmation for
  health-critical services) / restart, deploy, rollback, and add-service. Live
  fleet events refresh the grid; a 30s poll is the fallback.
- **Deploys** (`/deploys`) — deploy history filterable by service and status.
  Selecting a row opens a detail drawer with a live convergence bar and
  per-instance progress that updates from `ops:deploys` hub events (fast poll
  while a rollout is in flight, slow when idle).
- **Instances** (`/instances`) — per-instance view of the fleet: gateway
  version, leader, heartbeat freshness (stale flagging), and the services each
  instance is running.
- **Logs** (`/logs`) — xterm-based log viewer. Pick a service, instance, and
  tail length; follow-mode polls and appends only new lines. Re-colours with the
  light/dark theme.
- **Node stats** (`/stats`) — fleet summary cards (instance count, stale count,
  gateway-version spread with a mixed-version warning) over a grid of instance
  cards.

## Hardening

- **Auth gate** — `RequireAuth` blocks the authed shell until Cognito reports a
  valid session and redirects to `/login`, preserving the intended location in
  router state so the user returns after signing in.
- **Session expiry** — the axios response interceptor signs out on any `401`,
  which flips auth state to signed-out and lets `RequireAuth` bounce the user to
  `/login` (again preserving where they were). It also normalizes network
  failures into a single readable message for the pages.
- **Live hub cleanup** — signing out stops the shared SignalR connection so it
  doesn't keep reconnecting with a stale token.
- **Error boundary** — an `ErrorBoundary` wraps the shell and shows a recoverable
  reload card instead of a blank screen if a render throws.
- **404** — unmatched paths inside the shell render a Not Found page.

## Layout

- `src/api` — axios client + per-resource API modules
- `src/components` — AppShell (drawer nav), ErrorBoundary, shared widgets
- `src/contexts` — auth (sign-in → TOTP challenge → session), snackbar
- `src/hooks` — SignalR-backed live-data hooks
- `src/pages` — Services, Deploys, Instances, Logs, Node stats, Not Found
- `src/theme` — MUI theme, light/dark mode
- `src/lib` — Cognito client, SignalR hub client, xterm terminal wrapper
