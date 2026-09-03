# Quick Start

<Steps>

## Install SHAPI

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

Other install options: [Installation](./installation.md)

## Start the hub

```bash
shapi hub --relay
```

On first run, SHAPI prints an access token and saves it to `~/.hapi/settings.json`.

The legacy `hapi` command remains supported as an alias; `hapi server` remains an alias for `shapi hub`.

The terminal will display a URL and QR code for remote access.

> End-to-end encrypted with WireGuard + TLS.

## Start a coding session

```bash
shapi
```

This starts Claude Code wrapped with SHAPI. The session appears in the web UI.

## Open the UI

Open the URL shown in the terminal, or scan the QR code with your phone.

Enter your access token to log in.

</Steps>

## Next steps

- [Seamless Handoff](./how-it-works.md#seamless-handoff) - Switch between terminal and phone seamlessly
- [Hub setup](./installation.md#hub-setup) - Access SHAPI from anywhere
- [Notifications](./installation.md#telegram-setup) - Set up Telegram notifications
- [Install the App](./pwa.md) - Add SHAPI to your home screen
