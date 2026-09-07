// This function is serialized into the browser, not executed by Bun. Keep its
// small browser contract module-local; importing lib.dom would replace the
// Hub's Bun WebSocket/fetch types project-wide.
type PreviewLocation = URL & { assign(url: string): void; replace(url: string): void; reload(): void }
type PreviewStorage = {
    readonly length: number; clear(): void; getItem(key: string): string | null;
    key(index: number): string | null; removeItem(key: string): void; setItem(key: string, value: string): void
}
type PreviewEvent = { target: unknown }
declare class Element {
    closest(selector: string): Element | null
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
}
declare class HTMLFormElement extends Element { action: string }
declare class HTMLLinkElement extends Element { href: string }
declare class HTMLScriptElement extends Element { src: string }
declare class HTMLImageElement extends Element { src: string }
declare class MutationObserver {
    constructor(callback: () => void)
    observe(target: Element, options: Record<string, unknown>): void
}
declare const document: {
    cookie: string; title: string; head: Element | null;
    querySelector<T extends Element>(selector: string): T | null;
    addEventListener(type: string, callback: (event: PreviewEvent) => void, options?: boolean | { once: boolean }): void
}
declare const navigator: object
type PreviewWindow = {
    location: PreviewLocation; document: typeof document;
    fetch(input: Request | string, options?: RequestInit): Promise<Response>;
    WebSocket: typeof WebSocket; EventSource: typeof EventSource;
    postMessage(data: unknown, origin: string): void;
    addEventListener(type: string, callback: () => void, options?: { once: boolean }): void
}
declare const window: PreviewWindow
declare const parent: PreviewWindow
declare const history: { readonly state: unknown } & Record<'pushState' | 'replaceState', (data: unknown, unused: string, url?: string | URL | null) => void>
declare class XMLHttpRequest {
    open(method: string, url: string | URL, async: boolean, username?: string | null, password?: string | null): void
}
declare class EventSource {
    constructor(url: string | URL, options?: { withCredentials?: boolean })
}

export type PreviewRuntimeConfig = { origin: string; base: string; target: string; parents: readonly string[] }

/** Compatibility only. The opaque iframe + CSP remain the security boundary.
 * Never expose the parent's window, cookies, auth, or storage to this runtime. */
function installPreviewRuntime(config: PreviewRuntimeConfig): void {
    const realWindow = window
    const realLocation = realWindow.location
    const routeKey = '__shapi_preview_route__'
    const current = () => {
        const url = new URL(realLocation.href)
        const path = url.pathname.startsWith(config.base + '/') ? url.pathname.slice(config.base.length) : '/'
        const state = history.state
        if (state && typeof state === 'object' && routeKey in state && typeof state[routeKey] === 'string') {
            const routed = new URL(state[routeKey], config.target)
            if (routed.origin === config.target) return routed
        }
        return new URL(path + url.search + url.hash, config.target)
    }
    const map = (value: string | URL, websocket = false): string => {
        const url = new URL(String(value), current())
        const origin = websocket ? url.origin.replace(/^ws/, 'http') : url.origin
        if (origin === config.origin && url.pathname.startsWith(config.base + '/')) return url.href
        if (origin !== config.target && origin !== config.origin) return url.href
        return (websocket ? config.origin.replace(/^http/, 'ws') : config.origin) + config.base + url.pathname + url.search + url.hash
    }

    // Independent, bounded, in-memory website preferences. No HAPI storage access.
    const makeStorage = (): PreviewStorage => {
        const values = new Map<string, string>()
        return {
            get length() { return values.size },
            clear() { values.clear() },
            getItem(key) { return values.get(String(key)) ?? null },
            key(index) { return [...values.keys()][index] ?? null },
            removeItem(key) { values.delete(String(key)) },
            setItem(key, value) {
                key = String(key); value = String(value)
                let size = key.length + value.length
                for (const [name, text] of values) if (name !== key) size += name.length + text.length
                if (size > 512 * 1024 || (!values.has(key) && values.size >= 256)) throw new DOMException('Preview storage is full', 'QuotaExceededError')
                values.set(key, value)
            }
        }
    }
    for (const key of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(realWindow, key, { value: makeStorage(), configurable: false })
    }
    const cookies = new Map<string, string>()
    Object.defineProperty(document, 'cookie', {
        get: () => [...cookies].map(([key, value]) => key + '=' + value).join('; '),
        set: (raw: string) => {
            const parts = String(raw).split(';')
            const pair = parts.shift() ?? ''
            const split = pair.indexOf('=')
            if (split < 1 || pair.length > 4096) return
            const key = pair.slice(0, split).trim()
            const expired = parts.some((part) => /^\s*max-age\s*=\s*0\s*$/i.test(part)
                || (/^\s*expires=/i.test(part) && Date.parse(part.slice(part.indexOf('=') + 1)) < Date.now()))
            if (expired) cookies.delete(key)
            else if (cookies.has(key) || cookies.size < 64) cookies.set(key, pair.slice(split + 1))
        }
    })
    // The browser must never install a local site's worker onto the Hub origin.
    // Access to the native getter throws before many sites' registration catch.
    Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: false })

    const virtualLocation = new Proxy({} as PreviewLocation, {
        get(_target, key) {
            if (key === 'assign' || key === 'replace') return (value: string) => realLocation[key](map(value))
            if (key === 'reload') return () => realLocation.replace(map(current()))
            if (key === 'toString' || key === Symbol.toPrimitive) return () => current().href
            return Reflect.get(current(), key)
        },
        set(_target, key, value) {
            const url = current()
            if (!['href', 'pathname', 'search', 'hash'].includes(String(key))) return false
            Reflect.set(url, key, value)
            realLocation.assign(map(url))
            return true
        }
    })
    const virtualWindow = new Proxy({} as PreviewWindow, {
        get(_target, key) {
            if (key === 'location') return virtualLocation
            if (key === 'window' || key === 'self' || key === 'globalThis') return virtualWindow
            const value = Reflect.get(realWindow, key, realWindow)
            // Native Window methods need their original receiver; constructors do not.
            return typeof value === 'function' && /^[a-z]/.test(String(key)) ? value.bind(realWindow) : value
        },
        set(_target, key, value) {
            if (key === 'location') { realLocation.assign(map(String(value))); return true }
            return Reflect.set(realWindow, key, value, realWindow)
        },
        has(_target, key) { return key in realWindow }
    })
    Object.defineProperties(realWindow, {
        __SHAPI_PREVIEW_WINDOW__: { value: virtualWindow },
        __SHAPI_PREVIEW_LOCATION__: { value: virtualLocation }
    })
    for (const key of ['pushState', 'replaceState'] as const) {
        const original = history[key].bind(history)
        history[key] = (data: unknown, unused: string, url?: string | URL | null) => {
            const routed = new URL(url == null ? current().href : String(url), current())
            if (routed.origin === config.origin && routed.pathname.startsWith(config.base + '/')) {
                routed.href = config.target + routed.pathname.slice(config.base.length) + routed.search + routed.hash
            }
            if (routed.origin !== config.target) throw new DOMException('Cross-origin history is unavailable', 'SecurityError')
            // WebKit forbids path rewrites for opaque origins. Keep the real
            // capability URL unchanged; native history still provides back/forward.
            original({ ...(data && typeof data === 'object' ? data : {}), [routeKey]: routed.href }, unused)
        }
    }

    const originalFetch = realWindow.fetch
    realWindow.fetch = function(input, options) {
        const request = input instanceof Request ? new Request(map(input.url), input) : map(String(input))
        return originalFetch.call(realWindow, request, { ...options, credentials: 'omit' })
    }
    const originalOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(method: string, url: string | URL, async = true, username?: string | null, password?: string | null) {
        return originalOpen.call(this, method, map(url), async, username, password)
    }
    realWindow.WebSocket = new Proxy(WebSocket, {
        construct(Target, args: ConstructorParameters<typeof WebSocket>) { return new Target(map(args[0], true), args[1]) }
    })
    realWindow.EventSource = new Proxy(EventSource, {
        construct(Target, args: ConstructorParameters<typeof EventSource>) { return new Target(map(args[0]), { ...args[1], withCredentials: false }) }
    })
    // Vite route preloads and dynamically inserted assets use DOM properties,
    // not fetch. Map those URLs before the browser starts their requests.
    for (const [prototype, key] of [[HTMLLinkElement.prototype, 'href'], [HTMLScriptElement.prototype, 'src'], [HTMLImageElement.prototype, 'src']] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
        if (!descriptor?.set) continue
        Object.defineProperty(prototype, key, { ...descriptor, set(this: Element, value: string) {
            if (this instanceof HTMLLinkElement || this instanceof HTMLScriptElement) this.setAttribute('crossorigin', 'anonymous')
            descriptor.set!.call(this, map(value))
        } })
    }
    document.addEventListener('click', (event) => {
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        const value = anchor?.getAttribute('href')
        if (value && !value.startsWith('#')) anchor?.setAttribute('href', map(value))
    }, true)
    document.addEventListener('submit', (event) => {
        if (event.target instanceof HTMLFormElement) event.target.action = map(event.target.getAttribute('action') || current().href)
    }, true)

    const publishMetadata = () => {
        if (parent === realWindow) return
        const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"],link[rel="apple-touch-icon"]')
        const data = { type: 'shapi:preview-metadata', title: document.title.trim().slice(0, 200), icon: map(icon?.getAttribute('href') || '/favicon.ico') }
        for (const origin of config.parents) parent.postMessage(data, origin)
    }
    let scheduled = false
    const scheduleMetadata = () => {
        if (scheduled) return
        scheduled = true
        setTimeout(() => { scheduled = false; publishMetadata() }, 100)
    }
    document.addEventListener('DOMContentLoaded', () => {
        publishMetadata()
        if (document.head) new MutationObserver(scheduleMetadata).observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'rel'] })
    }, { once: true })
    realWindow.addEventListener('load', scheduleMetadata, { once: true })
}

export function previewRuntime(config: PreviewRuntimeConfig): string {
    return `(${installPreviewRuntime.toString()})(${JSON.stringify(config).replaceAll('<', '\\u003c')});`
}
