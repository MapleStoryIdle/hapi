# Installation

Install the SHAPI CLI and set up the hub.

## Prerequisites

- [Bun](https://bun.sh/) for building SHAPI from source
- Claude Code, OpenAI Codex CLI, Cursor Agent CLI, Google Gemini CLI, or OpenCode CLI installed

Verify your CLI is installed:

```bash
# For Claude Code
claude --version

# For OpenAI Codex CLI
codex --version

# For Cursor Agent CLI
agent --version

# For Google Gemini CLI
gemini --version

# For OpenCode CLI
opencode --version
```

## Architecture

SHAPI has three components:

| Component | Role | Required |
|-----------|------|----------|
| **CLI** | Wraps AI agents (Claude/Codex/Cursor/Gemini/OpenCode), runs sessions | Yes |
| **Hub** | Central coordinator: persistence, real-time sync, remote access | Yes |
| **Runner** | Background service for remote session spawning | Optional |

### How they work together

```
┌─────────────────────────────────────────────────────┐
│              Your Machine                           │
│                                                     │
│  ┌─────────┐    Socket.IO    ┌─────────────┐       │
│  │  CLI    │◄───────────────►│    Hub      │       │
│  │+ Agent  │                 │  + SQLite   │       │
│  └─────────┘                 └──────┬──────┘       │
│       ▲                             │ SSE          │
│       │ spawn                       ▼              │
│  ┌────┴────┐                 ┌─────────────┐       │
│  │ Runner  │◄────RPC────────►│   Web App   │       │
│  │(背景)   │                 └─────────────┘       │
│  └─────────┘                                       │
└─────────────────────────────────────────────────────┘
                    │
           [Tunnel / Public URL]
                    │
              ┌─────▼─────┐
              │ Phone/Web │
              └───────────┘
```

- **CLI**: Start a session with `shapi`. The CLI wraps your AI agent and syncs with the hub.
- **Hub**: Run `shapi hub`. Stores sessions, handles permissions, enables remote access.
- **Runner**: Run `shapi runner start`. Lets you spawn sessions from phone/web without keeping a terminal open.

### Typical workflows

**Local only**: `shapi hub` → `shapi` → work in terminal

**Remote access**: `shapi hub --relay` → `shapi runner start` → control from phone/web

## Install the CLI

The first SHAPI package release has not been published yet. Build the current
source on macOS or Linux:

```bash
git clone https://github.com/MapleStoryIdle/shapi.git
cd shapi
bun install
bun run build:single-exe
SHAPI_BUILD="$(find cli/dist-exe -type f -name hapi | head -n 1)"
sudo install "$SHAPI_BUILD" /usr/local/bin/shapi
sudo ln -sf /usr/local/bin/shapi /usr/local/bin/hapi
```

The former npm package and `tiann/tap/hapi` Homebrew formula are legacy upstream
install options; they do not contain this SHAPI source tree.

## Other install options

<details>
<summary>Prebuilt binary</summary>

Download the latest release from [GitHub Releases](https://github.com/MapleStoryIdle/shapi/releases).
Release archives keep the internal binary filename `hapi` for compatibility;
install it under the public `shapi` command and keep the old alias if needed.

```bash
xattr -d com.apple.quarantine ./hapi
chmod +x ./hapi
sudo install ./hapi /usr/local/bin/shapi
sudo ln -sf /usr/local/bin/shapi /usr/local/bin/hapi
```
</details>

<details>
<summary>Build from source</summary>

```bash
git clone https://github.com/MapleStoryIdle/shapi.git
cd shapi
bun install
bun run build:single-exe

# The build keeps the internal filename under cli/dist-exe/<bun-target>/hapi.
SHAPI_BUILD="$(find cli/dist-exe -type f -name hapi | head -n 1)"
sudo install "$SHAPI_BUILD" /usr/local/bin/shapi
sudo ln -sf /usr/local/bin/shapi /usr/local/bin/hapi
```
</details>

## Hub setup

The hub can be deployed on:

- **Local desktop** (default) - Run on your development machine
- **Remote host** - Deploy the hub on a VPS, cloud host, or any machine with network access

### Default: Public Relay (recommended)

```bash
shapi hub --relay
```

The terminal displays a URL and QR code. Scan to access from anywhere.

The legacy `hapi` command remains supported as an alias; `hapi server` remains an alias for `shapi hub`.

- **End-to-end encrypted** with WireGuard + TLS
- No configuration needed
- Works behind NAT, firewalls, and any network

> **Tip:** The relay uses UDP by default. If you experience connectivity issues, set `HAPI_RELAY_FORCE_TCP=true` to force TCP mode.

### Local Only

```bash
shapi hub
# or
shapi hub --no-relay
```

The hub listens on `http://localhost:3006` by default.

On first run, SHAPI:

1. Creates `~/.hapi/`
2. Generates a secure access token
3. Prints the token and saves it to `~/.hapi/settings.json`

<details>
<summary>Config files</summary>

```
~/.hapi/
├── settings.json      # Main configuration
├── hapi.db           # SQLite database (hub)
├── runner.state.json  # Runner process state
└── logs/             # Log files
```
</details>

<details>
<summary>Environment variables</summary>

| Variable | Default | settings.json | Description |
|----------|---------|---------------|-------------|
| `CLI_API_TOKEN` | Auto-generated | `cliApiToken` | Shared secret for authentication |
| `HAPI_API_URL` | `http://localhost:3006` | `apiUrl` | Hub URL for CLI connections |
| `HAPI_EXTRA_HEADERS_JSON` | - | - | JSON object of extra outbound headers for CLI → hub HTTP/WebSocket requests |
| `HAPI_LISTEN_HOST` | `127.0.0.1` | `listenHost` | Hub HTTP bind address |
| `HAPI_LISTEN_PORT` | `3006` | `listenPort` | Hub HTTP port |
| `HAPI_PUBLIC_URL` | - | `publicUrl` | Public URL for external access |
| `CORS_ORIGINS` | - | `corsOrigins` | Allowed CORS origins (comma-separated) |
| `TELEGRAM_BOT_TOKEN` | - | `telegramBotToken` | Telegram Bot API token |
| `TELEGRAM_NOTIFICATION` | `true` | `telegramNotification` | Enable Telegram notifications |
| `HAPI_RELAY_API` | `relay.hapi.run` | - | Relay API domain |
| `HAPI_OFFICIAL_WEB_URL` | `https://maplestoryidle.github.io/shapi` | - | Separate PWA URL shown in relay mode |
| `HAPI_RELAY_FORCE_TCP` | `false` | - | Force TCP mode for relay |
| `VAPID_SUBJECT` | SHAPI repository URL | - | Web Push contact info |
| `HAPI_HOME` | `~/.hapi` | - | Config directory path |
| `DB_PATH` | `~/.hapi/hapi.db` | - | Database file path |
| `ELEVENLABS_API_KEY` | - | - | ElevenLabs API key for voice |
| `ELEVENLABS_AGENT_ID` | Auto-created | - | Custom ElevenLabs agent ID |

The default `relay.hapi.run` endpoint is retained as an opt-in upstream
compatibility service and is not SHAPI-owned. For a fully self-hosted setup,
override both values with infrastructure you control.
</details>

<details>
<summary>settings.json example</summary>

Configuration priority: **ENV > settings.json > default**

When ENV values are set and not present in settings.json, they are automatically saved.

```json
{
  "$schema": "https://raw.githubusercontent.com/MapleStoryIdle/shapi/main/docs/public/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006,
  "publicUrl": "https://your-domain.com"
}
```

JSON Schema: [settings.schema.json](https://raw.githubusercontent.com/MapleStoryIdle/shapi/main/docs/public/schemas/settings.schema.json)
</details>

## CLI setup

If the hub is not on localhost, set these before running `shapi`:

```bash
export HAPI_API_URL="http://your-hub:3006"
export CLI_API_TOKEN="your-token-here"
export HAPI_EXTRA_HEADERS_JSON='{"Cookie":"CF_Authorization=..."}'
```

Or use interactive login:

```bash
shapi auth login
```

Authentication commands:

```bash
shapi auth status
shapi auth login
shapi auth logout
```

Each machine gets a unique ID stored in `~/.hapi/settings.json`. This allows:

- Multiple machines to connect to one hub
- Remote session spawning on specific machines
- Machine health monitoring

## Operations

### Self-hosted tunnels

If you prefer not to use the public relay (e.g., for lower latency or self-managed infrastructure), you can use these alternatives:

<details>
<summary>Cloudflare Tunnel</summary>

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

> **Note:** Cloudflare Quick Tunnels (TryCloudflare) are not supported because they [do not support SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), which SHAPI uses for real-time updates. Use a Named Tunnel instead.

**Named tunnel setup:**

```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Create and configure a named tunnel
cloudflared tunnel create shapi
cloudflared tunnel route dns shapi shapi.yourdomain.com

# Run the tunnel
cloudflared tunnel --protocol http2 run shapi
```

> **Tip:** Use `--protocol http2` instead of QUIC (the default) to avoid potential timeout issues with long-lived connections.

</details>

<details>
<summary>Tailscale</summary>

https://tailscale.com/download

```bash
sudo tailscale up
shapi hub
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```
</details>

<details>
<summary>Public IP / Reverse Proxy</summary>

If the hub has a public IP, access directly via `http://your-hub-ip:3006`.

Use HTTPS (via Nginx, Caddy, etc.) for production.

**Self-signed certificates (HTTPS)**

If `HAPI_API_URL` is set to an `https://...` URL with a self-signed (or otherwise untrusted) certificate, the CLI may fail with:

```
Error: self signed certificate
```

Recommended fixes (in order):

1. Use a publicly trusted certificate (e.g., Let's Encrypt)
2. Trust your private CA (recommended for private networks)
3. Dev-only workaround: disable TLS verification (insecure)

```bash
# Preferred: trust your own CA
export NODE_EXTRA_CA_CERTS="/path/to/your-ca.pem"

# Dev-only workaround: disable TLS verification (INSECURE)
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

If you use the dev-only workaround, assume MITM risk; do not use on public networks.

</details>

### Telegram setup

Enable Telegram notifications and Mini App access:

1. Message [@BotFather](https://t.me/BotFather) and create a bot
2. Set the bot token and public URL
3. Start the hub and bind your account

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export HAPI_PUBLIC_URL="https://your-public-url"

shapi hub
```

Then message your bot with `/start`, open the app, and enter your `CLI_API_TOKEN`.

**Troubleshooting:**

- If binding fails, verify `HAPI_PUBLIC_URL` is accessible from the internet
- Telegram Mini App requires HTTPS (not HTTP)

### Runner setup

Run a background service for remote session spawning:

```bash
shapi runner start
shapi runner status
shapi runner logs
shapi runner stop
```

With the runner running:

- Your machine appears in the "Machines" list
- You can spawn sessions remotely from the web app
- Sessions persist even when the terminal is closed

<details>
<summary>Alternative: pm2</summary>

If you prefer pm2 for process management:

```bash
pm2 start "shapi runner start-sync" --name hapi-runner
pm2 save
```
</details>

### Background service deployment

Keep SHAPI running persistently so it survives terminal closes, system restarts, and continues running in the background.

<details>
<summary>Quick: nohup</summary>

Simple one-liner for quick background runs:

```bash
# Hub
nohup shapi hub --relay > ~/.hapi/logs/hub.log 2>&1 &

# Runner
nohup shapi runner start-sync > ~/.hapi/logs/runner.log 2>&1 &
```

View logs:

```bash
tail -f ~/.hapi/logs/hub.log
tail -f ~/.hapi/logs/runner.log
```

Stop processes:

```bash
pkill -f "shapi hub"
pkill -f "shapi runner"
```
</details>

<details>
<summary>pm2 (recommended for Node.js users)</summary>

pm2 provides process management with auto-restart on crashes and system reboot.

```bash
# Install pm2
npm install -g pm2

# Start hub and runner
pm2 start "shapi hub --relay" --name hapi-hub
pm2 start "shapi runner start-sync" --name hapi-runner

# View status and logs
pm2 status
pm2 logs hapi-hub
pm2 logs hapi-runner

# Auto-restart on system reboot
pm2 startup    # Follow the printed instructions
pm2 save       # Save current process list
```
</details>

<details>
<summary>macOS: launchd</summary>

Create plist files for automatic startup on macOS.

**Hub** (`~/Library/LaunchAgents/com.hapi.hub.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/shapi</string>
        <string>hub</string>
        <string>--relay</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
</dict>
</plist>
```

**Runner** (`~/Library/LaunchAgents/com.hapi.runner.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/shapi</string>
        <string>runner</string>
        <string>start-sync</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
</dict>
</plist>
```

Load/unload services:

```bash
# Load (start)
launchctl load ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl load ~/Library/LaunchAgents/com.hapi.runner.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl unload ~/Library/LaunchAgents/com.hapi.runner.plist
```

> **macOS sleep note:** macOS may suspend background processes when the display sleeps. Use `caffeinate` to prevent this:
> ```bash
> caffeinate -dimsu shapi hub --relay
> ```
> Or run `caffeinate -dimsu` in a separate terminal while SHAPI is running.
</details>

<details>
<summary>Linux: systemd</summary>

Create user-level systemd services for automatic startup.

**Hub** (`~/.config/systemd/user/hapi-hub.service`):

```ini
[Unit]
Description=SHAPI Hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/shapi hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Runner** (`~/.config/systemd/user/hapi-runner.service`):

```ini
[Unit]
Description=SHAPI Runner
After=network.target hapi-hub.service

[Service]
Type=simple
KillMode=process
ExecStart=/usr/local/bin/shapi runner start-sync
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

> **Why `KillMode=process`?** The runner spawns each agent session as a detached child process (`detached: true` in `cli/src/runner/run.ts`) so that sessions stay alive when the runner exits. Without `KillMode=process`, systemd's default `KillMode=control-group` sends SIGTERM to every PID in the runner's cgroup when the unit stops, defeating the detach and forcibly archiving every running session. `KillMode=process` preserves the contract: stopping or restarting the runner only signals the runner itself; agent sessions stay alive, and a fresh runner re-establishes control via the existing socket.io reconnect path. This applies to runner upgrades, manual restarts, and any reboot in which the runner unit is stopped before agents have finished.

Enable and start:

```bash
# Reload systemd
systemctl --user daemon-reload

# Enable (auto-start on login)
systemctl --user enable hapi-hub
systemctl --user enable hapi-runner

# Start now
systemctl --user start hapi-hub
systemctl --user start hapi-runner

# View status/logs
systemctl --user status hapi-hub
journalctl --user -u hapi-hub -f
```

> **Persist after logout:** To keep services running even when not logged in:
> ```bash
> loginctl enable-linger $USER
> ```
</details>

### Voice assistant setup

Enable voice control:

1. Get an API key from [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys)
2. Set the environment variable:

```bash
export ELEVENLABS_API_KEY="your-api-key"
shapi hub --relay
```

See [Voice Assistant](./voice-assistant.md) for usage details.

### Security notes

- Keep tokens secret and rotate if needed
- Use HTTPS for public access
- Restrict CORS origins in production

<details>
<summary>Firewall example (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>
