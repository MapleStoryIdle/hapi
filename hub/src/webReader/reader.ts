import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { readerTags, type ReaderNode, type WebReaderResponse } from '@hapi/protocol/webReader'
import { probeAddressAllowed } from '../monitoring/probe'

const tags = new Set<string>(readerTags)

function positiveInteger(value: string | null, max = 20000): number | undefined {
    if (!value || !/^\d+$/.test(value)) return undefined
    const number = Number(value)
    return number > 0 && number <= max ? number : undefined
}

export function readerUrl(value: string): URL {
    if (value.length > 8192 || /[\x00-\x20\\]/.test(value)) throw new Error('Invalid URL')
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Invalid URL')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !probeAddressAllowed(host, false))) throw new Error('Private URL')
    url.hash = ''
    return url
}

export function requiresReader(headers: IncomingHttpHeaders, target: URL, parentOrigin: string): boolean {
    const xfo = String(headers['x-frame-options'] ?? '')
    if (/\bDENY\b/i.test(xfo)) return true
    if (/\bSAMEORIGIN\b/i.test(xfo) && target.origin !== parentOrigin) return true
    return /(?:^|;)\s*frame-ancestors\s+'none'(?:\s|;|$)/i.test(String(headers['content-security-policy'] ?? ''))
}

export function extractReader(html: string, url: URL): WebReaderResponse {
    // Linkedom parses only: it never runs scripts or fetches page subresources.
    const { document } = parseHTML(html)
    if (document.querySelectorAll('*').length > 20000) throw new Error('Page too complex')
    const title = document.title
    const article = new Readability(document, { maxElemsToParse: 20000, charThreshold: 100, disableJSONLD: true }).parse()
    if (!article?.content || !article.textContent?.trim()) throw new Error('No readable content')
    const parsed = parseHTML(`<html><body>${article.content}</body></html>`).document
    let count = 0
    function convert(node: typeof parsed.body.childNodes[number], depth: number): ReaderNode[] {
        if (++count > 20000 || depth > 60) return []
        if (node.nodeType === 3) return [node.textContent ?? '']
        if (node.nodeType !== 1) return []
        const element = node as typeof parsed.body
        const tag = element.localName.toLowerCase()
        if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math', 'template'].includes(tag)) return []
        if (tag === 'img') {
            const alt = element.getAttribute('alt')?.slice(0, 2000) ?? ''
            // Readability normalizes common lazy image attributes. Keep a single
            // validated source rather than copying arbitrary HTML/srcset attributes.
            const candidates = [element.getAttribute('data-src'), element.getAttribute('data-original'), element.getAttribute('src'), element.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0]]
            for (const candidate of candidates) {
                if (!candidate) continue
                try {
                    const src = readerUrl(new URL(candidate, url).href).href
                    return [{ tag: 'img', children: [], src, alt, width: positiveInteger(element.getAttribute('width')), height: positiveInteger(element.getAttribute('height')) }]
                } catch { /* try a real image after a data placeholder; never emit local/script URLs */ }
            }
            return alt ? [alt] : []
        }
        const children = Array.from(node.childNodes).flatMap(child => convert(child, depth + 1))
        if (!tags.has(tag)) return children
        let href: string | undefined
        if (tag === 'a') {
            try { href = readerUrl(new URL(element.getAttribute('href') ?? '', url).href).href } catch { /* retain text only */ }
            if (!href) return children
        }
        return [{ tag: tag as typeof readerTags[number], children, ...(href ? { href } : {}),
            ...(['td', 'th'].includes(tag) ? { colSpan: positiveInteger(element.getAttribute('colspan'), 1000), rowSpan: positiveInteger(element.getAttribute('rowspan'), 1000) } : {}) }]
    }
    const content = Array.from(parsed.body.childNodes).flatMap(node => convert(node, 0))
    return { mode: 'readonly', title: (article.title || title || url.hostname).slice(0, 300), url: url.href, content }
}

export async function readWebPage(value: string, parentOrigin: string, parentSignal?: AbortSignal): Promise<WebReaderResponse> {
    const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(parentSignal ? [parentSignal] : [])])
    let url = readerUrl(value)
    for (let hop = 0; hop < 5; hop++) {
        const host = url.hostname.replace(/^\[|\]$/g, '')
        const addresses = await new Promise<Awaited<ReturnType<typeof lookup>>>((resolve, reject) => {
            const abort = () => reject(new Error('Timeout'))
            signal.addEventListener('abort', abort, { once: true })
            void lookup(host).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
            if (signal.aborted) abort()
        })
        if (!probeAddressAllowed(addresses.address, false)) throw new Error('Private address')
        const pinned = new URL(url)
        pinned.hostname = addresses.family === 6 ? `[${addresses.address}]` : addresses.address
        const result = await new Promise<WebReaderResponse | { redirect: string }>((resolve, reject) => {
            // Literal verified socket address prevents DNS rebinding, including on Bun.
            const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(pinned, {
                method: 'GET', signal, agent: false, servername: host,
                headers: { Host: url.host, Accept: 'text/html', 'Accept-Encoding': 'identity' }
            }, response => {
                response.on('error', reject)
                const status = response.statusCode ?? 0
                if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
                    resolve({ redirect: response.headers.location }); response.destroy(); return
                }
                if (status < 200 || status >= 300) { reject(new Error('Page unavailable')); response.destroy(); return }
                // An embedding restriction is a terminal preview state, not permission
                // to download/extract a replacement document. Stop before reading body.
                resolve({ mode: requiresReader(response.headers, url, parentOrigin) ? 'blocked' : 'embed' })
                response.destroy()
                return
            })
            req.on('error', reject)
            req.end()
        })
        if (!('redirect' in result)) return result
        url = readerUrl(new URL(result.redirect, url).href)
    }
    throw new Error('Too many redirects')
}
