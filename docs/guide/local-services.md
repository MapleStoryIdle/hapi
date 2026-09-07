# Open Runner-local services from your phone

SHAPI can open HTTP(S) links to `localhost`, `127.0.0.1`, and `[::1]` on the
machine that owns a conversation. Ports come from each URL; they are not fixed.
Both managed sessions and native Codex sessions are supported.

On a phone, tap the original message link: the website loads **directly inside
the chat bottom drawer**. There is no extra launch confirmation or new tab.
The drawer remains scrollable, supports drag-to-close, and stays within 70% of
the visible viewport. Connection errors and retry stay in the drawer too.

SHAPI uses the existing chat login to create or reuse a logical tunnel over
the Runner's already authenticated Hub Socket.IO connection. No additional
public listener or SSH endpoint is started. Embedded previews receive a sandbox-only URL capability through the
authenticated API; no bootstrap page or third-party cookie is required.
Rendering a message alone never contacts the service or opens a tunnel.

Desktop clicks can retain the separate tab flow, with a short-lived one-use
ticket in the URL fragment. The drawer offers a copy-link icon, not an external-browser button. If a popup is
blocked, that explicitly requested action uses the authenticated launch route.

### Trusted Web origins for embedded previews

Only the configured Hub origin and explicit trusted Web origins may embed
local services. A separately hosted UI must have its exact origin in
`CORS_ORIGINS`, for example `https://chat.example.com`; `*` does **not**
grant iframe access. Relay mode includes the configured official Web origin.
The local development script includes its Vite Web origin by default.
An unconfigured parent gets an explicit API 403 instead of a silently blank
frame. Do not add arbitrary third-party sites to this allowlist.

Both path and domain modes use an opaque sandbox for drawer previews:
local pages cannot read the chat page, login storage or cookies. Assets,
fetch/XHR, SSE and WebSocket stay scoped to that local service. Preview pages
have bounded, in-memory cookie preferences and local/session storage of their
own; these are discarded on a full page reload and never contain SHAPI login
data. They are not a server-side cookie jar or a persistent website login.
Services that require server cookie authentication, service workers, third-party CDN/API
resources or external authentication may be incompatible with the sandbox;
failure and retry stay inside the drawer. Domain-mode embedded previews use a different lease origin from normal
tabs, so existing tab login cookies cannot weaken the drawer sandbox.

## Choose a mode

This feature is **disabled by default**. Choose one of these explicit modes
after upgrading both Hub and Runner:

| `HAPI_LOCAL_SERVICE_MODE` | `HAPI_LOCAL_SERVICE_ORIGIN` | Result |
| --- | --- | --- |
| `path` | Not needed | Same-origin path sandbox at `/preview/<leaseId>/<grantCapability>/...`. No preview domain and no gateway port `8321`. |
| `domain` | Required | Existing isolated wildcard-preview-domain mode. |
| Unset | Set | Domain mode, for compatibility with existing installations. |
| Unset | Unset | Disabled. |
| `off` | Any value | Disabled explicitly. |

`HAPI_LOCAL_SERVICE_ORIGIN` is an origin template, not a general URL. Its
presence with no mode selected chooses domain mode. In path mode, leave it
unset so a later configuration change cannot silently select domain mode.
There is no unsafe fallback from one mode to the other.

### Path mode: use the existing Hub origin

Path mode is the simplest choice when a separate preview domain is unavailable.
The Hub's normal HTTP/WebSocket listener serves `/preview/`; do not expose a
second HTTP gateway or configure `HAPI_LOCAL_SERVICE_GATEWAY_PORT` for this
mode. `HAPI_PUBLIC_URL` must be the externally visible, root Hub origin. HTTPS
is required outside loopback development.

```dotenv
HAPI_PUBLIC_URL=https://hub.example.com
HAPI_LOCAL_SERVICE_MODE=path
```

Keep the existing `/socket.io/` reverse proxy working. Both control and binary
forwarding frames use that authenticated connection; nothing connects to TCP
`8320`. Remove obsolete `HAPI_LOCAL_SERVICE_SSH_*` settings when convenient.
Upgrade Hub and Runner together: an older SSH-only Runner cannot serve the new
transport. Existing interactive SSH and Codex processes are unaffected.

If a reverse proxy fronts the Hub, forward `/preview/` to the **same** upstream
as the app and preserve the public Host, WebSocket Upgrade, and streaming. Do
not log its request URI: the capability is a bearer secret.

```nginx
# Put this map in the http block.
map $http_upgrade $shapi_preview_connection {
    default upgrade;
    '' close;
}

# Add this location to the server that already proxies the Hub.
location ^~ /preview/ {
    # Do not write /preview/* request URIs to reverse-proxy access logs.
    access_log off;
    proxy_pass http://127.0.0.1:3006;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $shapi_preview_connection;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

Keep the app's normal proxy location unchanged. If access logging is required,
use a dedicated format that omits the request URI and query string for
`/preview/*`; never copy, share, bookmark, or paste a path-capability URL.

The initial browser destination is
`/preview/<leaseId>/__shapi_local/open#<one-use-ticket>`. The fragment stays
out of HTTP requests. It is redeemed once into the opaque,
same-lease `/preview/<leaseId>/<grantCapability>/...` sandbox. That second URL
is a temporary bearer credential too. It is never a HAPI JWT or app-login
credential, but a page can read its own URL, so never share or log it. An
expired tab must reopen the original SHAPI link; it cannot silently authenticate
or fall back to a less restrictive path.

Path mode supports normal HTTP, streaming/SSE, uploads, and WebSockets. It
adapts HTML, CSS, JavaScript browser-global references, root-relative `fetch`,
XHR, `EventSource`, WebSocket and dynamically inserted asset URLs. Page scripts
see the original local URL and route base (such as `/studio/`), while requests
remain within the capability path. Native history entries retain a virtual
route for back/forward without changing the opaque document's real URL, which
WebKit forbids. No application route strings are replaced. This is compatibility
support, not a security boundary or a universal browser-origin emulator.
OAuth, nested iframes, workers, CDNs, arbitrary absolute module imports, and
complex SPAs are not guaranteed. External redirects are denied rather than followed, and a
failed adaptation never falls back to an unrestricted request.

Path-mode rewrites allow at most four bodies at once and 32 waiting requests;
normal SPA asset bursts queue instead of failing immediately. Waiting and
reading share a 15-second deadline: HTML/CSS buffers are limited to 2 MiB and JavaScript to 4 MiB.
Transformed scripts use an 8 MiB / 32-entry in-memory cache; Bun macros are
explicitly disabled so website code is never executed on the Hub.
The general 128 MiB response-stream
limit still applies to API responses, SSE, and files.

The drawer uses the website title and icon when available, otherwise the
original local URL and a generic web icon. Metadata is accepted only from the
currently embedded frame; icons must remain inside its own capability path.
The copy icon continues to copy the reconnectable SHAPI launch link, never a
temporary grant. No additional metadata polling is required.

The sandbox is opaque and limited to resources belonging to its lease. SHAPI
does not forward browser `Cookie` or `Authorization` headers to the local
service, and drops upstream `Set-Cookie` headers instead of retaining them at
the Hub origin. Configure the local app for relative URLs where possible. A
script-bearing local service must be trusted with its own data: its scripts can
read that service's temporary capability URL even though they never receive a
HAPI JWT.

### Domain mode: keep an isolated preview origin

Domain mode keeps its isolated browser origin, but also uses the existing Hub
connection for transport. Use it when the local app requires a conventional
isolated origin or stronger browser-origin separation. Configure a wildcard
preview domain with its own TLS certificate; prefer a registrable domain that
is separate from the SHAPI app. Never serve unrestricted preview HTML under the
SHAPI app origin or its `/api` path; same-origin previews require path mode's sandbox.

```dotenv
HAPI_LOCAL_SERVICE_MODE=domain
HAPI_LOCAL_SERVICE_ORIGIN=https://{id}.preview.example.net
HAPI_LOCAL_SERVICE_GATEWAY_PORT=8321
```

| Setting | Meaning / default |
| --- | --- |
| `HAPI_LOCAL_SERVICE_ORIGIN` | Domain mode only. Exactly one `{id}` as the first hostname label; no URL path. |
| `HAPI_LOCAL_SERVICE_GATEWAY_PORT` | Domain mode only. HTTP gateway port, default `8321`; binds to `127.0.0.1`, behind the TLS reverse proxy. |

Only the source machine's authenticated Runner can carry a lease's traffic.
There is no system sshd, SSH account/key, or shell/SFTP transport. Per-lease
loopback adapters inside the Hub are internal only and must never be exposed.

Point `*.preview.example.net` at the Hub. Configure a real certificate and
preserve Host, WebSocket Upgrade, and streaming. Keep preview request URIs out
of reverse-proxy access logs in this mode too.

```nginx
# Put this map in the http block.
map $http_upgrade $shapi_preview_connection {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name *.preview.example.net;
    ssl_certificate /etc/nginx/certs/preview-fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/preview-privkey.pem;
    client_max_body_size 50m;
    client_body_timeout 60s;

    location / {
        access_log off;
        proxy_pass http://127.0.0.1:8321;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $shapi_preview_connection;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Do not add wildcard preview origins to SHAPI's API CORS allowlist, bypass the
preview gateway with direct TCP exposure, or publish its loopback port. Keep
access logs private. Browser tickets travel in URL fragments, not HTTP query
parameters.

## Shared security boundaries and limits

- Only literal loopback hosts are accepted. No LAN IPs, DNS aliases, numeric
  IP tricks, URL credentials, SSH URLs, or non-HTTP services. Runner control
  ports and a co-located loopback Hub port are blocked.
- Local HTTPS still verifies certificates. A self-signed or hostname-mismatched
  certificate is rejected; SHAPI does not disable TLS verification globally.
- One tunnel is shared per user + namespace + source session + machine +
  service origin. Active traffic renews a 30-minute idle lease. Clicking the
  original SHAPI link after expiry rebuilds it automatically.
- Browser tickets are one use and last 30 seconds. Runner disconnect, Hub
  restart, or shutdown closes tunnels and active proxied connections.
- Per Runner: 5 tunnels; per tunnel: 24 TCP connections. Hub: 100 tunnels and
  200 active proxied requests/WebSockets. Request bodies: 50 MiB; response
  bodies and API/SSE/file streams: 128 MiB. Path-mode rewrites: at
  most four concurrent bodies, 2 MiB for HTML/CSS or 4 MiB for JavaScript and 15 seconds each. WS messages from the
  browser: 8 MiB; queued relay data: 1 MiB. These limits do not change Shares'
  separate file-size limits.
- Metadata stays in bounded memory. No SQLite writes, copied page bodies, or
  transcript polling. Control uses machine RPC; bytes use dedicated binary
  Socket.IO frames (not chat messages or Base64 JSON bodies), at most 64 KiB
  in flight per direction/channel. Each frame waits for a write acknowledgment,
  with a 30-second deadline. Disconnect drops queued work rather than replaying
  writes after reconnect. Preview traffic shares the existing connection and
  yields between chunks; it still consumes bandwidth while actively in use.

For local development only, a loopback Hub may use HTTP; domain mode may use
`http://{id}.localhost:<gateway-port>`. Production Hub and domain-mode preview
origins require HTTPS. Normal taps authenticate in the original chat, so a new
preview tab does not need access to the app's login storage. Copying a launch
link or opening it through a browser context menu may need that browser/profile
to sign in first. Real iOS PWA handoffs still require device acceptance testing.

## Verification

```bash
bun run test:shared src/localServices.test.ts
bun run test:hub src/localServices/localServices.test.ts src/localServices/pathPreview.test.ts src/localServices/pathGateway.test.ts src/web/routes/localServices.test.ts
bun run test:cli src/runner/localServiceTunnels.test.ts
bun run test:web src/sw.test.ts src/routes/local-service.test.tsx src/lib/local-service-links.test.ts src/lib/open-local-service.test.ts src/components/assistant-ui/markdown-a.test.tsx src/components/MarkdownRenderer.test.tsx
bun scripts/dev/check-local-services.ts
bun scripts/dev/check-local-services.ts --path
bun scripts/dev/check-local-service-browser.ts
```

The integration tests use the actual Runner, Hub Socket.IO transport, and
both the isolated-domain gateway and same-origin path handler on temporary
loopback ports. The browser script uses disposable Chromium and WebKit profiles
to exercise the opaque path sandbox. Production DNS/TLS/firewall setup and a
real-device iOS PWA check remain deployment acceptance steps.

The smoke script additionally starts a real Hub and source-built Runner, logs
in through HTTP, and checks both managed and native session access through
machine RPC. It uses disposable Hub/Runner/Codex state, a synthetic transcript,
and random loopback ports; it never launches an AI agent or sends a prompt.
Run it once normally for domain mode and once with `--path` for same-origin
path mode. Owned processes and temporary state are removed when the check
finishes.

With a local OpenViking instance already running at `http://127.0.0.1:1933`,
`bun scripts/dev/check-openviking-preview.ts` checks the real Studio page,
sidebar navigation, proxied API, title/icon and isolation in disposable
Chromium/WebKit profiles. It blocks upstream writes and does not change
OpenViking or production configuration. Custom browser binaries can be selected
with `SHAPI_CHECK_CHROMIUM_EXECUTABLE` and `SHAPI_CHECK_WEBKIT_EXECUTABLE`.
