# Hub agent rules

- Read `../docs/agents/auth.md` before authentication or workspace changes.
- Enforce workspace scope at storage, HTTP, Socket.IO, SSE, and RPC boundaries.
- SQLite writes and migrations need focused tests; do not inspect or mutate a
  production database unless explicitly requested.
- REST routes live in `src/web/routes/`; Socket handlers in
  `src/socket/handlers/cli/`; synchronization in `src/sync/`.
- Hub/Web-only releases must not publish or bump Runner artifacts.

