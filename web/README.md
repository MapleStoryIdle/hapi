# SHAPI Web

React Mini App / PWA for monitoring and controlling SHAPI sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- In a normal same-origin browser, enter the workspace's `spw...` credential once. The Hub exchanges it for an HttpOnly Web session cookie; the app does not retain `spw...` in localStorage.
- `CLI_API_TOKEN:<namespace>` and localStorage bearer tokens exist only for legacy/dev compatibility.
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the hub via SSE.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/install` - Runner install/update instructions generated for this Hub.
- `/pair` - Review and approve a pending Runner pairing.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/browse` - Browse connected Runner workspace roots.
- `/settings` - Application settings and connected Runner details.

## Features

### Session list (`src/components/SessionList.tsx`)

- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent flavor label (claude/codex/gemini).
- Model mode display.

### Chat interface (`src/components/SessionChat.tsx`)

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode toggle (default/acceptEdits/auto/bypassPermissions/plan).
- Model selection (default/sonnet/sonnet[1m]/opus/opus[1m]).
- Session abort and mode switch controls.
- Context size display.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Persists across reloads via `localStorage` keyed per session.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js
- Real-time via Socket.IO
- Resize handling

### Voice assistant

- ElevenLabs integration (@elevenlabs/react)
- Real-time voice control

### New session (`src/components/NewSession/`)

Modular session creation:

- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Permission mode toggle (YOLO mode)

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Exchanges `spw...` through `POST /api/v2/web-sessions`, then sends cookies plus CSRF protection on state-changing requests.
- The Hub session, not `spw...`, persists browser login. Expired or revoked sessions require the workspace credential again.
- Legacy/Telegram flows still use short-lived JWTs with refresh behavior.

Workspace identity comes from the authenticated Hub request; never accept a workspace ID from browser input as authorization. One workspace may show several paired Runners.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


If testing in Telegram, set:

- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

End-to-end browser tests for the scratchlist component (real Chromium, real
`inert` focus blocking, real localStorage round-trips) live at the repo root
under `e2e/`:

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The spec drives a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

Mobile session layout has a separate product contract and build/test guard:
[`MOBILE_LAYOUT_CONTRACT.md`](./MOBILE_LAYOUT_CONTRACT.md). Before changing
the top/bottom safe areas or keyboard behavior, run `bun run test:mobile-layout`.

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any SHAPI hub:

Current `spw...` Web sessions are same-origin cookies. Prefer serving `web/dist` from the Hub origin for workspace login. Cross-origin static hosting is retained for legacy/Telegram configurations and requires matching Hub CORS policy.

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the SHAPI hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.
