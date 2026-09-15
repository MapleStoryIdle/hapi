# Agent guide: development and verification

## Root commands

```bash
bun typecheck             # all packages
bun run test              # package tests + mobile guard
bun run dev               # Hub + Web
bun run build:single-exe  # all-in-one binary
```

Vitest files live next to source as `*.test.ts` or `*.test.tsx`. Prefer focused
tests during iteration; run the required root checks before delivery when the
change warrants the full suite.

## Local HAPI stack

```bash
scripts/dev/local-hapi.sh restart
```

- Hub: `127.0.0.1:8318`
- Web: `127.0.0.1:5173`
- Default token: `hapi-test-local:localdev`
- State home: `~/.hapi-local-dev`
- DB override: `HAPI_LOCAL_DB_PATH=<path>`
- Token override: `HAPI_LOCAL_ACCESS_TOKEN=<token>`

The script passes the DB path explicitly and injects the matching Web access
token. State persists across restarts.

## Output discipline

Noisy commands should write full output to a temporary file. On success report
only the command, exit status, test counts, and duration. On failure print the
first useful diagnostic plus at most a short tail. Never print compiled bundles
or minified JavaScript while checking for a marker; use `rg -l` or a bounded
match instead.

