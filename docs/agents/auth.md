# Agent guide: identity and isolation

Read before changing registration, login, Runner pairing, credentials, or
workspace-scoped data.

## Model

- A workspace is the authorization and data-isolation boundary.
- `spw...`: Web workspace credential. Browser login exchanges it for an
  HttpOnly session cookie. Never use it as a Runner credential.
- `spr...`: per-Runner credential bound to that Runner's P-256 public key. One
  workspace may own multiple Runners.
- Runner uses DPoP to exchange `spr` for short-lived access tokens. Normal
  requests do not send raw `spr`.
- New installs use workspace registration and Runner pairing.
- `CLI_API_TOKEN:<namespace>` exists only for legacy migration.

## Change map

| Concern | Paths |
| --- | --- |
| Web/Runner auth routes | `hub/src/web/routes/authV2.ts` |
| Hub auth middleware | `hub/src/auth/` |
| Workspace storage | `hub/src/store/workspaces.ts` |
| CLI keys/pairing/DPoP | `cli/src/authV2/` |
| Runner commands | `cli/src/commands/runner.ts` |
| Web login state | `web/src/hooks/useAuth*.ts` |

## Invariants

- Every session, machine, credential, pairing, Socket, SSE subscription, and
  RPC request is workspace-scoped.
- Web and Runner credentials are not interchangeable.
- Revocation must reject new access and disconnect existing Runner sockets.
- Never log raw `spw`, `spr`, private keys, session cookies, or access tokens.

