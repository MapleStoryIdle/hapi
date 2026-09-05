# Open Runner-local services from your phone

SHAPI can open HTTP(S) links to `localhost`, `127.0.0.1`, and `[::1]` on the
machine that owns a conversation. Ports come from each URL; they are not fixed.
Both managed sessions and native Codex sessions are supported.

Click the original message link. SHAPI reserves a new tab immediately, uses the
existing chat login to create or reuse a dedicated SSH reverse tunnel, and puts
only a short-lived, one-use ticket in the new tab's URL fragment. Rendering a
message does not contact the service or open a tunnel. Connection failures show
a short message and a retry button in that tab. If popups are blocked, the
authenticated launch route opens in the current tab instead.

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

# This is still a separate Runner-to-Hub SSH channel.
HAPI_LOCAL_SERVICE_SSH_HOST=hub.example.com
HAPI_LOCAL_SERVICE_SSH_BIND=0.0.0.0
HAPI_LOCAL_SERVICE_SSH_PORT=8320
```

`HAPI_LOCAL_SERVICE_SSH_HOST` must be reachable from every Runner. It defaults
to the public Hub hostname; use a DNS-only TCP hostname when a CDN does not
forward port `8320`. The SSH listener binds to `127.0.0.1` by default, so set
`HAPI_LOCAL_SERVICE_SSH_BIND` deliberately when Runners are remote. Port `8320`
is the default and should be firewalled to Runner addresses where possible.

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
applies basic adaptations for HTML, CSS, root-relative `fetch`, XHR,
`EventSource`, and WebSocket URLs so same-lease resources remain under their
capability path. It is deliberately not a general-purpose browser-origin
emulator. Cookies and storage, OAuth, iframes, workers, CDNs, and complex SPAs
are not guaranteed. External redirects are denied rather than followed, and a
failed adaptation never falls back to an unrestricted request.

Path-mode HTML and CSS rewrites allow at most four bodies at once, each with a
2 MiB buffer and a 15-second deadline. The general 128 MiB response-stream
limit still applies to API responses, SSE, and files.

The sandbox is opaque and limited to resources belonging to its lease. SHAPI
does not forward browser `Cookie` or `Authorization` headers to the local
service, and drops upstream `Set-Cookie` headers instead of retaining them at
the Hub origin. Configure the local app for relative URLs where possible. A
script-bearing local service must be trusted with its own data: its scripts can
read that service's temporary capability URL even though they never receive a
HAPI JWT.

### Domain mode: keep an isolated preview origin

Domain mode is unchanged. Use it when the local app requires a conventional
isolated origin or stronger browser-origin separation. Configure a wildcard
preview domain with its own TLS certificate; prefer a registrable domain that
is separate from the SHAPI app. Never serve unrestricted preview HTML under the
SHAPI app origin or its `/api` path; same-origin previews require path mode's sandbox.

```dotenv
HAPI_LOCAL_SERVICE_MODE=domain
HAPI_LOCAL_SERVICE_ORIGIN=https://{id}.preview.example.net
HAPI_LOCAL_SERVICE_SSH_HOST=hub.example.com
HAPI_LOCAL_SERVICE_SSH_BIND=0.0.0.0
HAPI_LOCAL_SERVICE_SSH_PORT=8320
HAPI_LOCAL_SERVICE_GATEWAY_PORT=8321
```

| Setting | Meaning / default |
| --- | --- |
| `HAPI_LOCAL_SERVICE_ORIGIN` | Domain mode only. Exactly one `{id}` as the first hostname label; no URL path. |
| `HAPI_LOCAL_SERVICE_SSH_HOST` | Host reachable by Runners; defaults to the Hub public URL hostname. Use a DNS-only host when a CDN does not forward TCP. |
| `HAPI_LOCAL_SERVICE_SSH_BIND` | SSH listener address, default `127.0.0.1`. Set explicitly for remote Runners. |
| `HAPI_LOCAL_SERVICE_SSH_PORT` | Dedicated SSH port, default `8320`; allow inbound access from Runner addresses where possible. |
| `HAPI_LOCAL_SERVICE_GATEWAY_PORT` | Domain mode only. HTTP gateway port, default `8321`; binds to `127.0.0.1`, behind the TLS reverse proxy. |

The SSH endpoint is built into SHAPI. It is **not system sshd**: no OS account,
root password, SSH key installation, or changes to an existing interactive SSH
session are needed. Only ephemeral, single-use forwarding credentials are
accepted; shell, SFTP, and arbitrary forwarding requests are rejected.

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
  bodies and API/SSE/file streams: 128 MiB. Path-mode HTML/CSS rewrites: at
  most four concurrent bodies, 2 MiB and 15 seconds each. WS messages from the
  browser: 8 MiB; queued relay data: 1 MiB. These limits do not change Shares'
  separate file-size limits.
- Metadata stays in bounded memory. No SQLite writes, copied page bodies, or
  transcript polling. Transfers do not travel through message RPC/Socket.IO.

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

The integration tests use the actual Runner SSH client, Hub SSH server, and
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
