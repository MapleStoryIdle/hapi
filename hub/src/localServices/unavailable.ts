import { randomBytes } from 'node:crypto'

/** Render transport errors inside the preview itself: iframe load fires even
 * for HTTP 502, and the parent must not inspect an opaque sandbox's document. */
export function localServiceUnavailable(request: Request, frameOrigins: readonly string[] = []): Response {
    const zh = request.headers.get('accept-language')?.split(',')[0].trim().toLowerCase().startsWith('zh') ?? false
    const message = zh ? '无法连接服务器' : 'Unable to connect to the server'
    const retry = zh ? '重新连接' : 'Try again'
    const destination = request.headers.get('sec-fetch-dest')
    // Never turn API/resource errors into HTML, or replay a failed POST.
    const document = request.method === 'GET' && (destination === 'iframe' || destination === 'document'
        || (!destination && request.headers.get('accept')?.includes('text/html')))
    const headers = new Headers({
        'content-type': document ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'
    })
    if (!document) return new Response(request.method === 'HEAD' ? null : message, { status: 502, headers })

    const nonce = randomBytes(16).toString('base64')
    headers.set('content-security-policy', [
        'sandbox allow-scripts', "default-src 'none'", `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'",
        `frame-ancestors ${frameOrigins.join(' ') || "'none'"}`
    ].join('; '))
    return new Response(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${message}</title><style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;font:16px/1.5 system-ui;color:CanvasText;background:Canvas}
main{padding:24px;text-align:center;overflow-wrap:anywhere}p{margin:0 0 16px}
button{min-height:44px;padding:8px 24px;border:1px solid ButtonBorder;border-radius:12px;font:inherit;color:ButtonText;background:ButtonFace;cursor:pointer;touch-action:manipulation}
button:focus-visible{outline:2px solid Highlight;outline-offset:3px}
</style></head><body><main><p role="alert">${message}</p><button type="button" id="retry">${retry}</button></main>
<script nonce="${nonce}">document.getElementById('retry').addEventListener('click',()=>location.reload());</script>
</body></html>`, { status: 502, headers })
}
