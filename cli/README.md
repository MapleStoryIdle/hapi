# SHAPI CLI

Run Claude Code, Codex, Cursor Agent, Gemini, or OpenCode sessions from your terminal and control them remotely through the SHAPI hub.

## What it does

- Starts Claude Code sessions and registers them with hapi-hub.
- Starts Codex mode for OpenAI-based sessions.
- Starts Cursor Agent mode for Cursor CLI sessions.
- Starts Gemini mode via ACP (Anthropic Code Plugins).
- Starts OpenCode mode via ACP and its plugin hook system.
- Provides an MCP stdio bridge for external tools.
- Manages a background runner for long-running sessions.
- Includes diagnostics and auth helpers.

## Typical flow

1. Start the Hub with workspace registration enabled (see `../hub/README.md`).
2. Run the Hub's `install.sh`; choose a new workspace or join one with an existing `spw...` credential.
3. The installer pairs this machine, starts the Runner, and prints the Hub URL plus `spw...`.
4. Sign in to Hub Web with `spw...`; run `shapi` locally or start sessions remotely.

## Commands

For scripts and IDE integrations, run `shapi --hapi-capabilities` (or a supported
subcommand with `--hapi-help-json`) to receive the stable JSON capability catalog.

### Session commands

- `shapi` - Start a Claude Code session (passes through Claude CLI flags). See `src/index.ts`.
- `shapi codex` - Start Codex mode. See `src/codex/runCodex.ts`.
- `shapi codex resume <sessionId>` - Resume existing Codex session.
- `shapi codex fork <sessionId>` - Fork a Codex CLI thread into a new SHAPI session while preserving its native model and reasoning configuration. Remote forks read the source transcript from the selected runner's own `CODEX_HOME`; that runner must be allowed to spawn in the transcript workspace.
- `shapi cursor` - Start Cursor Agent mode. See `src/cursor/runCursor.ts`.
  Supports `shapi cursor resume <chatId>`, `shapi cursor --continue`, `--mode plan|ask`, `--yolo`, `--model`.
  Local and remote modes supported; remote uses `agent -p` with stream-json.
- `shapi gemini` - Start Gemini mode via ACP. See `src/agent/runners/runAgentSession.ts`.
  Note: Gemini runs in remote mode only; it waits for messages from the hub UI/Telegram.
- `shapi opencode` - Start OpenCode mode via ACP. See `src/opencode/runOpencode.ts`.
  Note: OpenCode supports local and remote modes; local mode streams via OpenCode plugins.
- `shapi resume [sessionId]` - List resumable sessions for this machine or resume one locally.
- `shapi inspect-peer <session-id-or-prefix>` - Read another same-workspace SHAPI session's metadata and recent text; never resumes it.
- `shapi ping-peer <session-id-or-prefix> <message>` - Resume a peer session when needed, then deliver a handoff/nudge message. It refuses to message the calling SHAPI session itself; use `shapi ping-peer --list` for discovery.

### Resume a remote session locally

```bash
shapi resume
shapi resume <session-id>
```

`shapi resume` lists resumable sessions for the current machine. `shapi resume <session-id>` hands off an active remote session and opens the same SHAPI session in the local terminal.

### Authentication

- `shapi runner pair --hub <url> [--name <name>] [--web-token-file <path>]` - Generate this Runner's `spr...` credential and P-256 key, then request workspace approval.
- `shapi workspace register [--name <name>] --hub <url> [--registration-secret <secret>]` - Create a workspace and print its `spw...` Web credential.
- `shapi auth status|login|logout` - Legacy shared-token compatibility only; do not use for new workspace installs.

The CLI stores each Runner credential under `$HAPI_HOME/credentials-v2/runner-<hub-sha256>.json` with private-file permissions. It does not persist the workspace's `spw...` credential. The Runner exchanges `spr...` plus a DPoP proof for short-lived Hub access tokens.

See `src/authV2/`, `src/commands/runner.ts`, and `src/commands/workspace.ts`.

### Runner management

- `shapi runner start` - Start runner as detached process.
- `shapi runner pair --hub <url> [--name <name>]` - Pair this machine with an existing Web workspace.
- `shapi workspace register [--name <name>] --hub <url> [--registration-secret <secret>]` - Create an isolated workspace and print its one-time Web credential. The name defaults to the system username. Open-registration Hubs need no secret.
- `shapi uninstall` - Stop the Runner and remove the program/runtime files while preserving credentials.
- `shapi uninstall --purge` - Also remove all local SHAPI settings and credentials.
- `shapi runner stop` - Stop runner gracefully.
- `shapi runner status` - Show runner diagnostics.
- `shapi runner list` - List active sessions managed by runner.
- `shapi runner stop-session <sessionId>` - Terminate specific session.
- `shapi runner logs` - Print path to latest runner log file.

Both `start` and `start-sync` accept repeatable `--workspace-root <path>` (or `--workspace-root=<path>`). When set:

- The web `/browse` page surfaces scoped file trees rooted at those paths.
- The runner applies the roots only to `list-directory` browsing; explicitly requested sessions may use any directory the runner can access.
- `~` and `~/foo` are expanded.

Omitting the flag keeps the legacy behavior: no scoping, no `/browse` feature.

See `src/runner/run.ts`.

### Diagnostics

- `shapi doctor` - Show full diagnostics (version, runner status, logs, processes).
- `shapi doctor clean` - Kill runaway SHAPI processes.

See `src/ui/doctor.ts`.

### Other

- `shapi mcp` - Start MCP stdio bridge. See `src/codex/happyMcpStdioBridge.ts`.
- `shapi hub` - Start the bundled hub (single binary workflow).
- `shapi share publish <relative-file> [--expires <seconds>] [--session <session-id>] [--feedback] [--feedback-request <text>]` - Create an expiring public link / 中文看板任务 for one local file (5 minutes–7 days; default 24h). `--session` binds the task to its source SHAPI session; when run inside a managed SHAPI agent session, that source is filled in automatically. `--feedback` is Markdown-only and embeds a one-time, 10 MiB feedback contract in the public document; the external Agent must self-report its model and environment in the returned Markdown.
- `shapi share revoke <share-id>` - Revoke a public link. Public links are bearer links; redact `/s/*` paths in reverse-proxy logs.

The legacy `hapi` command remains supported as an alias; `hapi server` remains an alias for `shapi hub`.

## Configuration

See `src/configuration.ts` for all options.

### Core

- `HAPI_API_URL` - Hub base URL (default: `http://localhost:3006`). Pairing saves the selected Hub URL.
- `HAPI_HOME` - Config/data directory (default: `~/.hapi`).

New installs need no manually shared environment token. `CLI_API_TOKEN` remains the internal credential slot and legacy override: a paired Runner loads its `spr...` credential; old installations may still provide a shared Hub token through the environment or settings file.

### Optional

- `HAPI_EXPERIMENTAL` - Enable experimental features (true/1/yes).
- `HAPI_EXTRA_HEADERS_JSON` - JSON object of extra headers to send on CLI → hub requests, e.g. `{"Cookie":"CF_Authorization=..."}`.
- `HAPI_CLAUDE_PATH` - Path to a specific `claude` executable.
- `HAPI_HTTP_MCP_URL` - Default MCP target for `shapi mcp`.
- `HAPI_SESSION_ID` - Current SHAPI session ID exported into wrapped Agent processes.
- `HAPI_WAIT_ACTIVE_SECS` - Timeout for `shapi ping-peer` to wait after resuming a session (default: 60).
- `HAPI_OPENVIKING_API_KEY` (or `HAPI_OPENVIKING_BEARER_TOKEN`), `HAPI_OPENVIKING_ACCOUNT`, `HAPI_OPENVIKING_USER` - Optional OpenViking credentials for the read-only Context page. When omitted, the runner uses matching values from `~/.openviking/ovcli.conf`.

The recent Codex transcript API is runner-scoped: the selected runner reads its own `CODEX_HOME` through Hub RPC, so a remote Hub never needs access to your local transcript files.

Native sessions can be renamed from the session header menu, using the same
dialog as managed sessions. The runner calls Codex's `thread/name/set` metadata
API without resuming or interrupting the thread. Names are stored by Codex and
refreshed in SHAPI's list and detail views; older Codex versions without this
API return an error and keep the existing name.

Native Codex controls use the same composer as managed sessions. A runner-owned app-server turn can be stopped without killing Codex; an existing Desktop SSH control socket can interrupt only the exact currently running turn. Non-SSH external owners, exec-resume turns, and pending Desktop queue hand-offs do not expose a stop button. Interrupt acknowledgement is not completion: SHAPI waits for the matching terminal event before allowing its paused queue to resume.

Native input questions are not automatically canceled by the direct-send bridge.
Its pending question is returned in session status and answered through the
authenticated control endpoint with exact turn/item IDs. Closing the Web drawer
does not answer the question; refreshing can reopen it while its Runner connection
remains alive. A stopped/disconnected bridge cannot accept old answers.
Shared Desktop observers never reply to server requests without an explicit
handler, so checking status does not reject another UI's question or approval.
Desktop `request_user_input_async` forms can be recovered from loaded transcript
history. Their `accepted` tool result is not a user answer: Web sends an explicit
selection as an idempotent, structured user-message reply (queued when busy), not
as a permission approval. This does not recreate or control Desktop's own dialog.

Model, reasoning effort and supported Standard/Fast settings apply to new SHAPI messages. Already queued messages keep their saved settings. Preferences and queue pauses are stored in the runner's `native-codex-controls.json`; Codex global configuration is not changed. Codex may retain the model/effort in the thread's own configuration. Desktop's shared queue cannot accept per-message settings, so its model controls stay read-only; configured messages wait instead of silently losing their settings. Stopping pauses SHAPI's queue until the user explicitly resumes delivery.

### Runner

- `HAPI_RUNNER_HEARTBEAT_INTERVAL` - Heartbeat interval in ms (default: 60000).
- `HAPI_RUNNER_HTTP_TIMEOUT` - HTTP timeout for runner control in ms (default: 10000).

### Worktree (set by runner)

- `HAPI_WORKTREE_BASE_PATH` - Base repository path.
- `HAPI_WORKTREE_BRANCH` - Current branch name.
- `HAPI_WORKTREE_NAME` - Worktree name.
- `HAPI_WORKTREE_PATH` - Full worktree path.
- `HAPI_WORKTREE_CREATED_AT` - Creation timestamp (ms).

## Storage

Data is stored in `~/.hapi/` (or `$HAPI_HOME`):

- `settings.json` - Machine ID, selected Hub, compatibility settings. See `src/persistence.ts`.
- `credentials-v2/runner-<hub-sha256>.json` - Per-Hub `spr...`, P-256 key pair, workspace binding; mode `0600`.
- `runner.state.json` - Runner state (pid, port, version, heartbeat).
- `logs/` - Log files.

`spw...` is intentionally not stored by the CLI. Keep it in a password manager; Hub Web stores an HttpOnly session cookie after login.

## Requirements

- Claude CLI installed and logged in (`claude` on PATH).
- Cursor Agent CLI installed (`agent` on PATH) for `shapi cursor`. Install: `curl https://cursor.com/install -fsS | bash` (macOS/Linux), `irm 'https://cursor.com/install?win32=true' | iex` (Windows).
- OpenCode CLI installed (`opencode` on PATH).
- Bun for building from source.

## Build from source

From the repo root:

```bash
bun install
bun run build:cli
```

For an all-in-one binary that also embeds the web app:

```bash
bun run build:single-exe
```

### Runner-only release

Runner releases use the independent version in `runner-version.json` and GitHub Release tags named `runner-v*`:

```bash
# Only when Runner behavior/runtime changes
bun run build:runner-downloads
scripts/deploy/publish-runner-downloads.sh <ssh-host>
```

Hub/Web-only changes must not bump `runner-version.json` or publish Runner binaries. Runner updates are manual: rerun the Hub's `install.sh`; the script downloads, replaces, and restarts the Runner.

## Source structure

- `src/api/` - Bot communication (Socket.IO + REST).
- `src/authV2/` - Runner credentials, pairing, and DPoP authentication.
- `src/claude/` - Claude Code integration.
- `src/codex/` - Codex mode integration.
- `src/cursor/` - Cursor Agent integration.
- `src/agent/` - Multi-agent support (Gemini via ACP).
- `src/opencode/` - OpenCode ACP + hook integration.
- `src/runner/` - Background service.
- `src/commands/` - CLI command handlers.
- `src/ui/` - User interface and diagnostics.
- `src/modules/` - Tool implementations (ripgrep, difftastic, git).

## Related docs

- `../hub/README.md`
- `../web/README.md`
