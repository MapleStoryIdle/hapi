# SHAPI

Run official Claude Code / Codex / Gemini / OpenCode sessions locally and control them remotely through a Web / PWA / Telegram Mini App.

> **Why SHAPI?** SHAPI is a local-first evolution of [upstream HAPI](https://github.com/tiann/hapi) and an alternative to [upstream Happy](https://github.com/slopus/happy). See [Why SHAPI?](docs/guide/why-hapi.md) for the key differences.

## Features

- **Seamless Handoff** - Work locally, switch to remote when needed, switch back anytime. No context loss, no session restart.
- **Native First** - SHAPI wraps your AI agent instead of replacing it. Same terminal, same experience, same muscle memory.
- **AFK Without Stopping** - Step away from your desk? Approve AI requests from your phone with one tap.
- **Your AI, Your Choice** - Claude Code, Codex, Cursor Agent, Gemini, OpenCode—different models, one unified workflow.
- **Terminal Anywhere** - Run commands from your phone or browser, directly connected to the working machine.
- **Voice Control** - Talk to your AI agent hands-free using the built-in voice assistant.
- **Workspace Browser** - Opt-in via one or more `shapi runner start --workspace-root <path>` flags: browse scoped file trees from the web. Sessions can still start in any directory the runner can access.

## Demo

https://github.com/user-attachments/assets/38230353-94c6-4dbe-9c29-b2a2cc457546

## Getting Started

Until the first SHAPI package release is published, build the all-in-one binary
from this repository (macOS/Linux):

```bash
git clone https://github.com/MapleStoryIdle/shapi.git
cd shapi
bun install
bun run build:single-exe
SHAPI_BUILD="$(find cli/dist-exe -type f -name hapi | head -n 1)"
sudo install "$SHAPI_BUILD" /usr/local/bin/shapi
sudo ln -sf /usr/local/bin/shapi /usr/local/bin/hapi

shapi hub --relay     # start hub with E2E encrypted relay
shapi                 # run Claude Code
```

The built executable still accepts the legacy `hapi` command name for
compatibility; `hapi server` remains an alias for `shapi hub`.

The terminal will display a URL and QR code. Scan the QR code with your phone or open the URL to access.

> The relay uses WireGuard + TLS for end-to-end encryption. Your data is encrypted from your device to your machine.

For self-hosted options (Cloudflare Tunnel, Tailscale), see [Installation](docs/guide/installation.md)

## Docs

- [App](docs/guide/pwa.md)
- [How it Works](docs/guide/how-it-works.md)
- [Cursor Agent](docs/guide/cursor.md)
- [Voice Assistant](docs/guide/voice-assistant.md)
- [Why SHAPI](docs/guide/why-hapi.md)
- [FAQ](docs/guide/faq.md)

## Credits and lineage

SHAPI is derived from [upstream HAPI](https://github.com/tiann/hapi), which in turn
contains work derived from [upstream Happy](https://github.com/slopus/happy). Their
authors and contributors made this project possible. See [cli/NOTICE](cli/NOTICE)
for retained copyright and license notices.
