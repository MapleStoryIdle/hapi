# Open Runner-local services from your phone

SHAPI can open HTTP(S) links to `localhost`, `127.0.0.1`, and `[::1]` on the
machine that owns a conversation. Ports come from each URL; they are not fixed.
Both managed sessions and native Codex sessions are supported.

Click the original message link. SHAPI reserves a new tab immediately, uses the
existing chat's login to create or reuse a dedicated SSH reverse tunnel, and
passes only a one-time preview ticket to that tab. The tab redirects to an
isolated preview hostname, without logging in to SHAPI again. No confirmation
dialog or permanent conversation entry is added. Rendering a message does not
contact the service or open a tunnel. Connection failures show a short message
and a retry button in that same tab. If popups are blocked, the authenticated
launch route opens in the current tab instead.

## One-time Hub configuration

This feature is **disabled by default**. Upgrade both Hub and Runner, then
configure a wildcard preview domain and its TLS certificate. Prefer a separate
registrable domain from the SHAPI app. Never serve untrusted preview HTML under
the SHAPI app origin or its `/api` path.

Example (placeholder domains only):

```dotenv
HAPI_LOCAL_SERVICE_ORIGIN=https://{id}.preview.example.net
HAPI_LOCAL_SERVICE_SSH_HOST=hub.example.com
HAPI_LOCAL_SERVICE_SSH_BIND=0.0.0.0
HAPI_LOCAL_SERVICE_SSH_PORT=8320
HAPI_LOCAL_SERVICE_GATEWAY_PORT=8321
```

| Setting | Meaning / default |
| --- | --- |
| `HAPI_LOCAL_SERVICE_ORIGIN` | Required opt-in. Exactly one `{id}` as the first hostname label; no URL path. |
| `HAPI_LOCAL_SERVICE_SSH_HOST` | Host reachable by Runners; defaults to the Hub public URL hostname. Use a DNS-only host when a CDN does not forward TCP. |
| `HAPI_LOCAL_SERVICE_SSH_BIND` | SSH listener address, default `127.0.0.1`. Set explicitly for remote Runners. |
| `HAPI_LOCAL_SERVICE_SSH_PORT` | Dedicated SSH port, default `8320`; allow inbound access from Runner addresses where possible. |
| `HAPI_LOCAL_SERVICE_GATEWAY_PORT` | HTTP gateway port, default `8321`; always binds to `127.0.0.1`, behind the TLS reverse proxy. |

The SSH endpoint is built into SHAPI. It is **not system sshd**: no OS account,
root password, SSH key installation, or changes to an existing interactive SSH
session are needed. Only ephemeral, single-use forwarding credentials are
accepted; shell, SFTP, and arbitrary forwarding requests are rejected.

Point `*.preview.example.net` at the Hub. Example Nginx server (configure a real
certificate; preserve Host, WebSocket Upgrade, and streaming):

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
preview gateway with a direct TCP exposure, or publish the gateway's loopback
ports. Keep access logs private: application paths can contain sensitive data.
Access tickets themselves travel in URL fragments, not HTTP query parameters.

## Behavior and limits

- Path, query, and fragment are preserved. Relative page assets, normal HTTP
  login cookies, streaming/SSE, uploads, and WebSocket text/binary messages are
  supported. The gateway does not send its access cookie to the local service.
- One tunnel per user + namespace + source session + machine + service origin.
  Concurrent clicks share a tunnel. Active traffic renews a 30-minute idle
  lease. Clicking the original SHAPI link after expiry rebuilds it automatically.
  An already-expired preview tab asks you to reopen the original link; it cannot
  silently authenticate itself. No bookmarks or extra entries are stored.
- Browser access tickets: one use, 30 seconds. Preview cookies: host-only,
  HttpOnly, Secure in production, maximum 8 hours. Access expiry closes active
  streams too (15-second sweep interval). Runner disconnect, Hub restart, or
  shutdown closes its tunnels. Application login may be required again after
  a new preview hostname is created.
- Per Runner: 5 tunnels; per tunnel: 24 TCP connections. Hub: 100 tunnels and
  200 active proxied requests/WebSockets. Request bodies: 50 MiB; response
  bodies: 128 MiB. WS messages from the browser: 8 MiB; queued relay data: 1 MiB.
  These limits do not change Shares' separate file-size limits.
- Metadata stays in bounded memory. No SQLite writes, copied page bodies, or
  transcript polling. Transfers do not travel through message RPC/Socket.IO.
- Only literal loopback hosts are accepted. No LAN IPs, DNS aliases, numeric IP
  tricks, URL credentials, SSH URLs, or non-HTTP services. Runner control ports
  and a co-located loopback Hub port are blocked.
- Local HTTPS still verifies certificates. A self-signed or hostname-mismatched
  certificate is rejected; SHAPI does not disable TLS verification globally.
- JavaScript/HTML with hardcoded absolute `localhost` URLs to other ports is
  not rewritten. Configure that application to use relative URLs or its preview
  public origin. Service workers are blocked on temporary preview hosts.
- A preview is an authenticated personal view, not a public share. Another
  person cannot open a copied preview URL without a valid access cookie/ticket.

For local development only, a loopback SHAPI app may use an
`http://{id}.localhost:<gateway-port>` origin. All production previews require
HTTPS. Normal taps authenticate in the original chat, so a new preview tab does
not need access to SHAPI's login storage. Copying the launch link or using a
browser's context-menu / modifier-key "open in new tab" uses the authenticated
launch route instead; that browser/profile may need to sign in first. Real
iOS PWA handoffs still require device acceptance testing.

## Verification

```bash
bun run test:shared src/localServices.test.ts
bun run test:hub src/localServices/localServices.test.ts src/web/routes/localServices.test.ts
bun run test:cli src/runner/localServiceTunnels.test.ts
bun run test:web src/routes/local-service.test.tsx src/lib/local-service-links.test.ts src/lib/open-local-service.test.ts src/components/assistant-ui/markdown-a.test.tsx src/components/MarkdownRenderer.test.tsx
bun scripts/dev/check-local-services.ts
```

The integration tests use the actual Runner SSH client, Hub SSH server, and
gateway on temporary loopback ports. Production DNS/TLS/firewall setup and a
real-device iOS PWA check remain deployment acceptance steps.

The smoke script additionally starts a real Hub and source-built Runner, logs
in through HTTP, and checks both managed and native session access through
machine RPC. It uses disposable Hub/Runner/Codex state, a synthetic transcript,
and random loopback ports; it never launches an AI agent or sends a prompt.
Owned processes and temporary state are removed when the check finishes.
