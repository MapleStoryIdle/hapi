import type { IncomingHttpHeaders } from 'node:http'
import type { LocalServiceLease } from './manager'

export type PathPreview = Pick<LocalServiceLease, 'origin' | 'target'> & { basePath: string }

/** A URL capability is deliberately scoped to one lease. Never use HAPI auth
 * cookies/storage in the opaque sandbox, and never forward browser credentials. */
export function pathPreviewHeaders(headers: IncomingHttpHeaders, preview: PathPreview): IncomingHttpHeaders {
    const result = { ...headers }
    for (const name of [
        'set-cookie', 'content-security-policy', 'content-security-policy-report-only',
        'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
        'access-control-expose-headers', 'access-control-allow-methods', 'access-control-max-age',
        'clear-site-data', 'service-worker-allowed', 'www-authenticate', 'refresh', 'link',
        'report-to', 'reporting-endpoints', 'nel', 'content-location', 'alt-svc',
        'strict-transport-security', 'public-key-pins', 'public-key-pins-report-only',
        'authentication-info', 'proxy-authentication-info', 'accept-ch', 'critical-ch',
        'origin-agent-cluster', 'document-policy', 'document-isolation-policy'
    ]) delete result[name]
    for (const name of Object.keys(result)) if (name.startsWith('cross-origin-')) delete result[name]
    const scope = preview.origin + preview.basePath + '/'
    result['content-security-policy'] = [
        'sandbox allow-scripts allow-forms', "default-src 'none'",
        `script-src ${scope} 'unsafe-inline' 'unsafe-eval'`,
        `style-src ${scope} 'unsafe-inline'`, `img-src ${scope} data: blob:`,
        `font-src ${scope} data:`, `media-src ${scope} blob:`,
        `connect-src ${scope} ${scope.replace(/^http/, 'ws')}`,
        "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'",
        `form-action ${scope}`, "frame-ancestors 'none'"
    ].join('; ')
    result['content-type'] ??= 'text/plain; charset=utf-8'
    result['x-content-type-options'] = 'nosniff'
    result['referrer-policy'] = 'no-referrer'
    result['cache-control'] = 'no-store'
    result['cross-origin-opener-policy'] = 'same-origin'
    result['permissions-policy'] = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    // The opaque preview origin serializes to "null". The unguessable path
    // grants access, not Origin:null (which any sandbox can produce).
    result['access-control-allow-origin'] = 'null'
    result.vary = 'Origin'
    return result
}

/** Root-relative/relative and same-service absolute URLs only. No redirect
 * may escape the capability: CSP path checks are weakened after redirects. */
export function rewritePreviewUrl(value: string, preview: PathPreview, upstreamPath: string): string | null {
    try {
        const url = new URL(value, preview.target.origin + upstreamPath)
        if (url.origin !== preview.target.origin || url.username || url.password) return null
        return preview.origin + preview.basePath + url.pathname + url.search + url.hash
    } catch { return null }
}

export function rewritePreviewCss(css: string, preview: PathPreview, upstreamPath: string): string {
    const rewrite = (url: string) => rewritePreviewUrl(url, preview, upstreamPath) ?? url
    return css.replace(/url\(\s*(["']?)([^"')]*?)\1\s*\)/gi, (_all, _quote: string, url: string) => `url(${JSON.stringify(rewrite(url))})`)
        .replace(/(@import\s+)(["'])([^"']+)\2/gi, (_all, prefix: string, _quote: string, url: string) => prefix + JSON.stringify(rewrite(url)))
}

function runtime(preview: PathPreview): string {
    const config = JSON.stringify({ origin: preview.origin, base: preview.basePath, target: preview.target.origin }).replaceAll('<', '\\u003c')
    // URL adaptation only. CSP + the server-side lease/grant check are the
    // security boundary; monkey-patching browser APIs is never trusted.
    return `(()=>{const c=${config};
const map=(value,ws=false)=>{try{const s=String(value);const current=new URL(location.href);const tail=current.pathname.slice(c.base.length)+current.search;const u=new URL(s,c.target+tail);const origin=ws?u.origin.replace(/^ws/,'http'):u.origin;if(origin===c.origin&&u.pathname.startsWith(c.base+'/'))return s;if(origin!==c.target&&origin!==c.origin)return s;return (ws?c.origin.replace(/^http/,'ws'):c.origin)+c.base+u.pathname+u.search+u.hash;}catch{return value;}};
const originalFetch=window.fetch;window.fetch=function(input,options){if(input instanceof Request){const next=new Request(map(input.url),input);return originalFetch.call(this,next,{...options,credentials:'omit'});}return originalFetch.call(this,map(input),{...options,credentials:'omit'});};
const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){return open.call(this,method,map(url),...rest);};
for(const key of ['WebSocket','EventSource']){const Native=window[key];if(Native)window[key]=new Proxy(Native,{construct(Target,args){args[0]=map(args[0],key==='WebSocket');if(key==='EventSource')args[1]={...args[1],withCredentials:false};return Reflect.construct(Target,args);}});}
document.addEventListener('click',e=>{const a=e.target.closest?.('a[href]');if(a){const value=a.getAttribute('href');if(value&&!value.startsWith('#'))a.setAttribute('href',map(value));}},true);
document.addEventListener('submit',e=>{const f=e.target;if(f instanceof HTMLFormElement)f.action=map(f.getAttribute('action')||location.href);},true);
})();`
}

export function rewritePreviewHtml(response: Response, preview: PathPreview, upstreamPath: string): Response {
    let injected = false
    const inject = () => {
        if (injected) return ''
        injected = true
        return `<script>${runtime(preview)}</script>`
    }
    return new HTMLRewriter()
        .on('head', { element(element) { element.prepend(inject(), { html: true }) } })
        .on('body', { element(element) { element.prepend(inject(), { html: true }) } })
        .on('base', { element(element) { element.remove() } })
        .on('meta[http-equiv]', { element(element) {
            if (['refresh', 'content-security-policy', 'set-cookie'].includes(element.getAttribute('http-equiv')?.toLowerCase() ?? '')) element.remove()
        } })
        .on('*', { element(element) {
            for (const name of ['href', 'src', 'action', 'formaction', 'poster']) {
                const value = element.getAttribute(name)
                if (!value || value.startsWith('#')) continue
                const rewritten = rewritePreviewUrl(value, preview, upstreamPath)
                if (rewritten) element.setAttribute(name, rewritten)
            }
            const srcset = element.getAttribute('srcset')
            if (srcset && !srcset.includes('data:')) element.setAttribute('srcset', srcset.split(',').map((item) => {
                const [url, ...descriptor] = item.trim().split(/\s+/)
                return [rewritePreviewUrl(url, preview, upstreamPath) ?? url, ...descriptor].join(' ')
            }).join(', '))
            const style = element.getAttribute('style')
            if (style) element.setAttribute('style', rewritePreviewCss(style, preview, upstreamPath))
            // Modules/fonts request with CORS because the document is opaque.
            // Do not forward cross-origin credential modes requested upstream.
            if (element.hasAttribute('crossorigin')) element.setAttribute('crossorigin', 'anonymous')
        } })
        .transform(response)
}
