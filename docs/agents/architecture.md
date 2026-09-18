# Agent architecture map

Read this only when a task crosses packages or the owning area is unclear.

## Runtime flow

```text
CLI / Runner -- Socket.IO --> Hub -- SSE / REST --> Web PWA
      |                       |
      +-- agent processes     +-- SQLite, session cache, RPC gateway
```

1. CLI wraps Claude Code, Codex, Gemini, Cursor, or OpenCode.
2. CLI sends agent events to Hub over Socket.IO.
3. Hub persists messages and broadcasts changes over SSE.
4. Web sends actions through Hub REST; Hub forwards Runner RPC calls.

`shared` owns types, runtime schemas, socket contracts, message parsing, and
mode definitions consumed by the other packages.

## Source map

| Concern | Primary path |
| --- | --- |
| CLI commands | `cli/src/commands/`, `cli/src/index.ts` |
| Agent wrappers | `cli/src/claude/`, `cli/src/codex/`, `cli/src/agent/` |
| Runner daemon | `cli/src/runner/` |
| Hub REST routes | `hub/src/web/routes/` |
| Hub Socket.IO | `hub/src/socket/handlers/cli/` |
| Session/message synchronization | `hub/src/sync/` |
| SQLite persistence | `hub/src/store/` |
| SSE | `hub/src/sse/` |
| Web routes | `web/src/routes/`, `web/src/router.tsx` |
| Web reusable UI | `web/src/components/` |
| Web queries/mutations | `web/src/hooks/` |
| Shared contracts | `shared/src/types.ts`, `schemas.ts`, `socket.ts` |

## Important patterns

- RPC: CLI registers handlers; Hub routes through `rpcGateway.ts`.
- Versioned updates: Hub rejects stale metadata/state versions.
- Session modes: `local` and `remote` can switch during a session.
- Isolation: workspace scope must hold across storage, HTTP, Socket.IO, SSE,
  and RPC boundaries.
