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

## Layout

- `src/api` — axios client + per-resource API modules
- `src/components` — AppShell (drawer nav), shared widgets
- `src/contexts` — auth (sign-in → TOTP challenge → session)
- `src/hooks` — SignalR-backed live-data hooks
- `src/pages` — Services, Deploys, Instances, Logs, Node stats
- `src/theme` — MUI theme, light/dark mode
