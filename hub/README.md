# hapi-hub (SHAPI Hub)

Telegram bot + HTTP API + realtime updates for the SHAPI hub.

## What it does

- Telegram bot for notifications and the Mini App entrypoint.
- HTTP API for sessions, messages, permissions, machines, and files.
- Server-Sent Events stream for live updates in the web app.
- Socket.IO channel for CLI connections.
- Serves the web app from `web/dist` or embedded assets in the single binary.
- Persists state in SQLite.

## Configuration

See `src/configuration.ts` for all options.

### Workspace registration and authentication

- `HAPI_REGISTRATION_MODE` - `closed`, `secret`, or `open`. Defaults to `secret` when a registration secret exists; otherwise `closed`.
- `HAPI_REGISTRATION_SECRET` - Required in `secret` mode; minimum 32 bytes. Installers supply it only while creating a workspace.
- `CLI_API_TOKEN` - Legacy shared-token bridge, auto-generated when absent. Keep it during migration, but do not distribute it to new users or use it for new Runner pairing.

Each workspace is an authorization and data-isolation boundary. Its `spw...` credential creates browser sessions and approves any number of independently keyed `spr...` Runners.

### Optional (Telegram)

- `TELEGRAM_BOT_TOKEN` - Token from @BotFather.
- `HAPI_PUBLIC_URL` - Public HTTPS URL for Telegram Mini App access. Also used to derive default CORS origins for the web app.

### Optional (Voice)

- `ELEVENLABS_API_KEY` - ElevenLabs API key for voice assistant.
- `ELEVENLABS_AGENT_ID` - Custom ElevenLabs agent ID (auto-created if not set).

### Optional

- `HAPI_LISTEN_HOST` - HTTP bind address (default: 127.0.0.1).
- `HAPI_LISTEN_PORT` - HTTP port (default: 3006).
- `CORS_ORIGINS` - Comma-separated origins, or `*`.
- `HAPI_HOME` - Data directory (default: ~/.hapi).
- `DB_PATH` - SQLite database path (default: HAPI_HOME/hapi.db).
- `TELEGRAM_NOTIFICATION` - Enable/disable Telegram notifications (default: true).
- `HAPI_RELAY_API` - Relay API domain (default: relay.hapi.run).
- `HAPI_RELAY_AUTH` - Relay auth key (default: hapi).
- `HAPI_RELAY_FORCE_TCP` - Force TCP relay mode (true/1).
- `HAPI_OFFICIAL_WEB_URL` - Separate PWA URL shown in relay mode (default: the SHAPI GitHub Pages app).
- `VAPID_SUBJECT` - Contact email/URL for Web Push (default: the SHAPI repository URL).

`relay.hapi.run` is retained as an opt-in upstream compatibility service; it is
not a SHAPI-owned domain. Self-hosters should set `HAPI_RELAY_API` and
`HAPI_OFFICIAL_WEB_URL` to infrastructure they control.

## Running

### Optional local service access

To open Runner-local HTTP(S) links from session messages, upgrade both the Hub
and Runner, then choose a preview mode. Path mode
(`HAPI_LOCAL_SERVICE_MODE=path`) uses this Hub's existing HTTP/WebSocket listener
at `/preview/<leaseId>/<grantCapability>/...`; it needs no preview domain or
gateway port `8321`. All traffic uses the Runner's existing authenticated
Socket.IO connection to the Hub. No SSH endpoint, extra public port, firewall
rule, or additional domain is needed. Old `HAPI_LOCAL_SERVICE_SSH_*` settings
are unused and can be removed.
The capability URL is temporary and must not be shared or logged; it is never
a HAPI JWT.

Domain mode (`HAPI_LOCAL_SERVICE_MODE=domain`) retains the isolated wildcard
preview origin configured by `HAPI_LOCAL_SERVICE_ORIGIN` and its loopback
gateway. With no mode set, that origin selects compatible domain mode; with no
local-service settings, access stays disabled. Set the mode to `off` to disable
it explicitly. See [Local services](../docs/guide/local-services.md) for the
environment variables, reverse-proxy logging rules, security boundaries, and
limits.

Binary (single executable):

```bash
export TELEGRAM_BOT_TOKEN="..."
export HAPI_PUBLIC_URL="https://your-domain.example"
export HAPI_REGISTRATION_MODE="open" # or secret + HAPI_REGISTRATION_SECRET

shapi hub
```

The legacy `hapi` command remains supported as an alias; `hapi server` remains an alias for `shapi hub`.

If you only need web + CLI, you can omit TELEGRAM_BOT_TOKEN.
To enable Telegram, set TELEGRAM_BOT_TOKEN and HAPI_PUBLIC_URL, start the hub, open `/app`
in the bot chat, and bind the Mini App with the workspace's `spw...` credential when prompted.

From source:

```bash
bun install
bun run dev:hub
```

## HTTP API

### Events and service checks

See [Events and service checks](../docs/guide/monitoring.md) for mobile setup,
webhook authentication, probe safety, repair approval and retention limits.

- `/api/monitors` — workspace-authenticated configuration and seven-day metrics.
- `/api/monitors/:id` — detail, incidents and original-session links.
- `POST /hooks/events?token=YOUR_RULE_TOKEN` with JSON `{"prompt":"..."}` — bounded webhook ingestion; disable query-string logging for this credential-bearing endpoint. GET/HEAD cannot trigger work.

The Hub starts a bounded monitoring scheduler; with no rules it sends no probes
and creates no sessions. HTTP checks originate from the Hub network.

See `src/web/routes/` for all endpoints.

### Authentication (`src/web/routes/authV2.ts`)

- `POST /api/v2/workspaces/register` - Create a workspace when registration policy permits.
- `POST /api/v2/web-sessions` - Exchange `spw...` for HttpOnly session + CSRF cookies.
- `GET|DELETE /api/v2/web-sessions/current` - Inspect or revoke the current browser session.
- `POST /api/v2/runner/device-authorizations` - Start Runner pairing.
- `POST /api/v2/runner/device-authorizations/:userCode/approve` - Bind a Runner to the current browser's workspace.
- `POST /api/v2/runner/token` - Exchange `spr...` + DPoP proof for a short-lived access token.
- `POST /api/v2/runner/socket-tickets` - Exchange Runner access for a single Socket.IO ticket.

`src/web/routes/auth.ts` retains `POST /api/auth` and `/api/bind` for Telegram and legacy clients. `CLI_API_TOKEN:<namespace>` is migration compatibility, not the current onboarding path.

### Sessions (`src/web/routes/sessions.ts`)

- `GET /api/sessions` - List all sessions.
- `GET /api/sessions/:id` - Get session details.
- `POST /api/sessions/:id/abort` - Abort session.
- `POST /api/sessions/:id/switch` - Switch session to remote mode.
- `POST /api/sessions/:id/resume` - Resume inactive session.
- `POST /api/sessions/:id/upload` - Upload file (base64, max 50MB).
- `POST /api/sessions/:id/upload/delete` - Delete uploaded file.
- `POST /api/sessions/:id/archive` - Archive active session.
- `PATCH /api/sessions/:id` - Rename session.
- `DELETE /api/sessions/:id` - Delete inactive session.
- `GET /api/sessions/:id/slash-commands` - List slash commands.
- `GET /api/sessions/:id/skills` - List skills.
- `POST /api/sessions/:id/permission-mode` - Set permission mode.
- `POST /api/sessions/:id/model` - Set model preference.
- `POST /api/sessions/:id/effort` - Set Claude effort preference.

### Messages (`src/web/routes/messages.ts`)

- `GET /api/sessions/:id/messages` - Get messages (paginated).
- `POST /api/sessions/:id/messages` - Send message.

### Permissions (`src/web/routes/permissions.ts`)

- `POST /api/sessions/:id/permissions/:requestId/approve` - Approve permission.
- `POST /api/sessions/:id/permissions/:requestId/deny` - Deny permission.

### Machines (`src/web/routes/machines.ts`)

- `GET /api/machines` - List online machines.
- `POST /api/machines/:id/spawn` - Spawn new session on machine.
- `POST /api/machines/:id/paths/exists` - Check if path exists.

### Git/Files (`src/web/routes/git.ts`)

- `GET /api/sessions/:id/git-status` - Git status.
- `GET /api/sessions/:id/git-diff-numstat` - Diff summary.
- `GET /api/sessions/:id/git-diff-file` - File-specific diff.
- `GET /api/sessions/:id/file` - Read file content.
- `GET /api/sessions/:id/files` - File search with ripgrep.

### Events (`src/web/routes/events.ts`)

- `GET /api/events` - SSE stream for live updates.
- `POST /api/visibility` - Report client visibility state.

### Voice (`src/web/routes/voice.ts`)

- `POST /api/voice/token` - Get ElevenLabs conversation token.

### Push Notifications (`src/web/routes/push.ts`)

- `GET /api/push/vapid-public-key` - Get VAPID public key.
- `POST /api/push/subscribe` - Subscribe to push notifications.
- `DELETE /api/push/subscribe` - Unsubscribe.

### CLI (`src/web/routes/cli.ts`)

- `POST /cli/sessions` - Create/load session.
- `GET /cli/sessions/:id` - Get session by ID.
- `POST /cli/machines` - Create/load machine.
- `GET /cli/machines/:id` - Get machine by ID.

## Socket.IO

See `src/socket/handlers/cli.ts` for event handlers.

Namespace: `/cli`

### Client events (CLI to hub)

- `message` - Send message to session.
- `update-metadata` - Update session metadata.
- `update-state` - Update agent state.
- `session-alive` - Keep session active.
- `session-ready` - Cursor ACP `session/load` (or `newSession`) succeeded; hub defers merge/dedup until this arrives on reopen.
- `session-end` - Mark session ended.
- `machine-alive` - Keep machine online.
- `rpc-register` - Register RPC handler.
- `rpc-unregister` - Unregister RPC handler.

### Terminal events (web to hub)

- `terminal:create` - Open terminal for session.
- `terminal:write` - Send input.
- `terminal:resize` - Resize dimensions.
- `terminal:close` - Close terminal.

### Hub events (hub to clients)

- `update` - Broadcast session/message updates.
- `rpc-request` - Incoming RPC call.

See `src/socket/rpcRegistry.ts` for RPC routing.

## Telegram Bot

See `src/telegram/bot.ts` for bot implementation.

### Commands

- `/start` - Welcome message with Mini App link.
- `/app` - Open Mini App.

### Features

- Permission request notifications with approve/deny buttons.
- Session ready notifications.
- Deep links to Mini App sessions.

See `src/telegram/callbacks.ts` for button handlers.

## Core Logic

See `src/sync/syncEngine.ts` for the main session/message manager:

- In-memory session cache with versioning.
- Message pagination and retrieval.
- Permission approval/denial.
- RPC method routing via Socket.IO.
- Event publishing to SSE and Telegram.
- Git operations and file search.
- Activity tracking and timeouts.

## Storage

See `src/store/index.ts` for SQLite persistence:

- Sessions with metadata and agent state.
- Messages with pagination support.
- Machines with runner state.
- Workspaces and scoped access keys.
- Runner pairings and public-key bindings.
- Revocable Web sessions; raw Web credentials are stored as hashes.
- Todo extraction from messages.
- Users table for Telegram-to-workspace bindings (stored through the workspace data namespace).

## Source structure

- `src/web/` - HTTP service and routes.
- `src/socket/` - Socket.IO setup and handlers.
- `src/socket/handlers/cli/` - Modular CLI handlers.
- `src/telegram/` - Telegram bot.
- `src/sync/` - Core session/message logic.
- `src/store/` - SQLite persistence.
- `src/sse/` - Server-Sent Events.
- `src/config/` - Configuration loading and generation.
- `src/notifications/` - Push and Telegram notifications.
- `src/visibility/` - Client visibility tracking.

## Security model

Access is controlled by:
- Workspace scope on sessions, machines, messages, SSE, RPC, and file operations.
- Browser `spw...` exchange into HttpOnly session cookies plus CSRF checks.
- Per-Runner `spr...` credentials bound to P-256 public keys. DPoP proofs protect token exchange and Runner requests; access tokens are short-lived.
- Telegram initData verification plus a workspace binding.
- Legacy shared-token namespaces only while old installations are migrated.

Auth v2 clients reject non-HTTPS public Hub URLs; localhost HTTP is allowed for development. Keep TLS termination and reverse-proxy headers correct.

## Build for deployment

From the repo root:

```bash
bun run build:hub
bun run build:web
```

The hub build output is `hub/dist/index.js`, and the web assets are in `web/dist`.

## Networking notes

- Telegram Mini Apps require HTTPS and a public URL. If the hub has no public IP, use Cloudflare Tunnel or Tailscale and set `HAPI_PUBLIC_URL` to the HTTPS endpoint.
- If the web app is hosted on a different origin, set `CORS_ORIGINS` (or `HAPI_PUBLIC_URL`) to include that static host origin.

## Standalone web hosting

The web UI can be hosted separately from the hub (for example on GitHub Pages or Cloudflare Pages):

1. Build and deploy `web/dist` from the repo root.
2. Set `CORS_ORIGINS` (or `HAPI_PUBLIC_URL`) to the static host origin.
3. Open the static site, click the Hub button on the login screen, and enter the SHAPI hub origin.

Leaving the hub override empty preserves the default same-origin behavior when the hub serves the web assets directly.
