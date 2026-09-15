# SHAPI Runner

Agent-facing guide to the background process that connects one machine to one Hub workspace and manages remotely started coding sessions.

## Invariants

- One live Runner process per `$HAPI_HOME`; `runner.state.json.lock` enforces ownership.
- One paired Runner identity per Hub URL: `spr...` credential + P-256 private key.
- One Runner belongs to one workspace. One workspace may contain many Runners.
- Workspace roots scope file-tree browsing only. They do not sandbox agent processes or restrict explicitly requested session directories.
- Runner downloads are never triggered by Hub Web. A user updates by rerunning the Hub's installer.

## Entry points

- `src/commands/runner.ts` - `pair`, `start`, `start-sync`, `stop`, `status`, `list`, `logs`.
- `src/runnerBootstrap.ts` - small Runner-only executable entry.
- `src/runner/run.ts` - lifecycle, process tracking, Hub connection, RPC handlers.
- `src/runner/controlServer.ts` - loopback-only local control HTTP server.
- `src/runner/controlClient.ts` - CLI calls into the local control server and handles stale state.

`shapi runner start` launches a detached `start-sync` process. `start-sync` owns the long-running event loop.

## Install and pair

Preferred user path:

```bash
curl -fsSL https://hub.example.com/install.sh | sh -s -- --base-url https://hub.example.com
```

The installer:

1. Downloads or replaces the Runner-only binary.
2. Adds `$HOME/.local/bin` to the user's shell startup file when needed.
3. Interactively creates a workspace or joins an existing one.
4. Pairs this machine.
5. Starts the Runner.
6. Prints the Hub URL, `spw...` Web credential, and Runner status.

Manual primitives:

```bash
shapi workspace register --hub https://hub.example.com [--name <workspace>] [--registration-secret <secret>]
shapi runner pair --hub https://hub.example.com [--name <machine>] [--web-token-file <path>]
shapi runner start [--workspace-root <path>]...
```

`--name` is a display name. Workspace registration defaults it to the operating-system username; Runner pairing defaults to the machine hostname.

## Identity and authentication

Current flow:

1. `workspace register` generates an `spw...` credential locally, sends it over HTTPS while creating the workspace, and the Hub stores only its hash.
2. `runner pair` generates `spr...` plus a P-256 key pair in `src/authV2/credentials.ts`.
3. Hub creates a short-lived device authorization and returns a human code plus `/pair` URL.
4. A signed-in browser approves the code, or the installer approves it with a temporary `spw...` file.
5. Runner stores the approved workspace/access-key binding locally.
6. `src/authV2/runnerAuth.ts` exchanges `spr...` + an ES256 DPoP proof at `/api/v2/runner/token` for a short-lived access token.
7. Each authenticated REST request uses a fresh DPoP proof. Socket.IO first obtains a one-time socket ticket.

Security boundaries:

- Never send or store `spw...` as a Runner credential.
- Never copy one Runner's `spr...` or private key to another machine.
- Hub binds `spr...`, machine ID, workspace, and public-key thumbprint.
- Hub rejects stale/replayed DPoP proofs and Runner socket access without Runner-compatible credentials.
- `CLI_API_TOKEN:<namespace>` is legacy migration compatibility only.

Credential file:

```text
$HAPI_HOME/credentials-v2/runner-<sha256(normalized-hub-url)>.json
```

The directory is mode `0700`; files are mode `0600`. The CLI intentionally does not persist `spw...`.

## Startup lifecycle

`startRunner()` performs these stages:

1. Install signal and fatal-error shutdown handlers.
2. Inspect state/process identity; stop stale or incompatible Runner state.
3. Acquire the exclusive Runner lock.
4. Load paired auth and establish/confirm the machine ID.
5. Start Fastify on a random `127.0.0.1` port.
6. Persist `runner.state.json` with PID, port, Runner version, identity fingerprint, argv, log path, and heartbeat data.
7. Register/update machine metadata and Runner state with the Hub.
8. Connect the machine Socket.IO client and register RPC handlers.
9. Track child sessions and heartbeat until shutdown.

Transient machine-registration failures retry with bounded exponential backoff. Shutdown updates Hub state, closes Socket.IO/control server, removes local state, and releases the lock.

## Local control server

Loopback-only endpoints; not a public Hub API:

| Endpoint | Purpose |
|---|---|
| `POST /session-started` | Child reports its SHAPI session ID and metadata |
| `POST /list` | List tracked live sessions |
| `POST /stop-session` | Stop one tracked session |
| `POST /spawn-session` | Start/resume a simple or worktree session |
| `POST /stop` | Request graceful Runner shutdown |
| `POST /codex-recovery-*` | Coordinate native Codex control recovery |
| `POST /codex-external-*` | Forward reduced native Codex request/lifecycle signals |

The port is discovered through `runner.state.json`. Treat that file as process coordination, not durable product data.

## Hub connection and RPC

The Runner creates or refreshes its machine through REST, then maintains the `/cli` Socket.IO namespace through `ApiMachineSyncClient`.

Primary RPC handlers registered in `run.ts`:

- `spawnSession`
- `stopSession`
- `requestShutdown`
- `recoverCodexControl`
- `getCodexRecovery`

Machine metadata is built in `src/agent/sessionFactory.ts`. It includes platform/capabilities, optional workspace roots, and `runnerVersion`. `happyCliVersion` remains a compatibility field; use `runnerVersion` for update notices.

Hub routes RPC only within the authenticated workspace. Preserve workspace scope when adding REST, Socket.IO, SSE, or RPC behavior.

## Sessions and worktrees

- Runner-spawned children are recorded before waiting for their `/session-started` callback.
- Terminal-spawned sessions may report themselves and become tracked.
- Late callbacks from timed-out Runner-spawned children are rejected and the orphan process is terminated.
- Missing directories return a structured approval request instead of being created silently.
- Worktree creation/removal lives in `src/runner/worktree.ts`.
- Process termination uses platform-aware helpers in `src/utils/process.ts`.

## Workspace roots

Repeat `--workspace-root` to expose multiple directory trees in Hub Web:

```bash
shapi runner start --workspace-root ~/code --workspace-root /data/projects
```

`src/utils/workspaceRoot.ts` normalizes roots. Directory browsing validates against those roots. Session spawn remains allowed in any explicit directory accessible to the operating-system user. Do not describe workspace roots as an OS sandbox.

## Version and update behavior

- Dedicated version source: `cli/runner-version.json` via `src/runnerVersion.ts`.
- Hub Web compares machine `runnerVersion` with `/downloads/runner/latest.json` and can show/copy the installer command.
- The user updates manually by rerunning `install.sh`; Hub Web does not invoke Runner update RPCs.
- The installer replaces the local binary and starts/restarts the Runner.
- A live Runner can hand off to the already-installed binary when it detects local binary/source mtime drift. This is local process replacement, not network auto-update. `HAPI_DISABLE_VERSION_HANDOFF=1` disables it for external supervisors.

Runner release only:

```bash
# From repository root; bump cli/runner-version.json first
bun run build:runner-downloads
scripts/deploy/publish-runner-downloads.sh <ssh-host>
```

Binaries are attached to GitHub Releases tagged `runner-v*`. The Hub hosts `install.sh` and `latest.json`; the publish flow keeps the newest three Runner releases. Hub/Web-only changes must not bump the Runner version or publish Runner binaries.

## Local files

Under `~/.hapi/` or `$HAPI_HOME`:

- `settings.json` - machine ID, Hub URL, compatibility settings.
- `credentials-v2/` - per-Hub Runner credentials and private keys.
- `runner.state.json` - live process/control metadata.
- `runner.state.json.lock` - exclusive live-Runner lock.
- `logs/` - Runner and CLI logs.
- `native-codex-control-recovery.json` - native Codex recovery coordination.

## Change map

| Change | Start here |
|---|---|
| Pairing/credentials | `src/authV2/credentials.ts`, `src/authV2/pairRunner.ts` |
| DPoP/token exchange | `src/authV2/runnerAuth.ts`, `src/api/api.ts` |
| Lifecycle/session spawn | `src/runner/run.ts` |
| Local commands/control | `src/commands/runner.ts`, `src/runner/controlClient.ts`, `src/runner/controlServer.ts` |
| Machine metadata/RPC | `src/agent/sessionFactory.ts`, `src/api/apiMachine.ts` |
| Workspace browsing roots | `src/utils/workspaceRoot.ts`, Runner directory RPC modules |
| Installer/release | `scripts/install.sh`, `scripts/release/prepare-runner-downloads.ts`, `scripts/deploy/publish-runner-downloads.sh` |

## Verification

Run focused tests first, then repository checks before push:

```bash
(cd cli && bun run test)
bun typecheck
bun run test
```

For installer/release changes, also run `scripts/tests/install-runner.test.sh` and `scripts/tests/prune-runner-releases.test.sh`.
