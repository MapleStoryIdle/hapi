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

### Install or update a runner

The Hub serves a small installer and release manifest while Runner binaries are
hosted by GitHub Releases. Run the same command for the first installation and
every later manual update:

```bash
curl -fsSL https://hub.example.com/install.sh | sh -s -- --base-url https://hub.example.com
```

For the production Hub, the URL is built in:

```bash
curl -fsSL https://hapi.ye2moe.fun/install.sh | sh
```

The Hub's `/downloads/runner/latest.json` points to an immutable `runner-v*`
GitHub Release. The installer verifies the published SHA-256 before replacing `~/.local/bin/shapi`; it configures the
default shell PATH and shows download progress. A fresh interactive install
asks whether to create a new workspace or join an existing one with its `spw`,
then pairs and starts the Runner automatically. It finishes by printing the Hub
URL and `spw`. Updates preserve credentials and restart the Runner. The Hub Web compares each Runner's
reported version with `/downloads/runner/latest.json` and shows this command
when an update is available. It never starts an update remotely.

Use `shapi uninstall` to remove the program while retaining credentials, or
`shapi uninstall --purge` to remove all local SHAPI data as well.

Operators build and publish Runner-only GitHub Release assets separately from
the Hub binary:

```bash
# Only when Runner code changes: bump cli/runner-version.json first.
bun run build:runner-downloads
scripts/deploy/publish-runner-downloads.sh <ssh-host>
```

Hub/Web and Runner use independent versions. A Hub/Web-only deployment does not
change `cli/runner-version.json` and must not run the Runner publish command, so
it neither creates nor replaces a GitHub Release. Runner machines report the
dedicated Runner version for the Hub Web update check.

Configure Nginx once with
`scripts/deploy/shapi-runner-downloads.nginx.conf`; the Hub serves only
`install.sh` and `latest.json`. The publish script keeps the newest three
`runner-v*` GitHub Releases.

### Connect a private workspace and runners

Each person can register an isolated workspace on the Hub. The command prints a
one-time `spw…` Web credential; the CLI does not save it. For public
self-registration, the Hub operator configures:

```bash
export HAPI_REGISTRATION_MODE=open
shapi hub
```

The new user's CLI generates the `spw…` key locally and sends it once over HTTPS;
the Hub stores only its hash:

```bash
shapi workspace register --hub https://hub.example.com
```

The workspace name is optional and defaults to the system username. Operators
can instead use `HAPI_REGISTRATION_MODE=secret` with a 32-byte
`HAPI_REGISTRATION_SECRET`, or `closed` to disable registration. Public Hub URLs
must use HTTPS.

Open the Hub itself (not a separate cross-origin Web app), enter the `spw…`
credential once, and the Hub creates a long-lived HttpOnly browser session.
Then pair each computer with its own `spr…` runner credential:

```bash
shapi runner pair --hub https://hub.example.com --name "Office Mac"
shapi runner start
```

Enter the displayed 8-character code at `https://hub.example.com/pair`. One
workspace may contain many independently revocable runners. Web and runner
credentials cannot be used for each other's purpose. The Hub installation page
at `/install` contains the same instructions.

After pairing, the long-lived `spr…` never travels as an ordinary API bearer:
the runner proves possession of its local P-256 private key, receives a
five-minute DPoP access token, and uses a one-time 30-second ticket for each
Socket.IO connection. Revoking that runner also disconnects its live sockets.

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
