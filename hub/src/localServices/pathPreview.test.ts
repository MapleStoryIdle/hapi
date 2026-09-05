import { describe, expect, it } from 'bun:test'
import { parseLocalServiceUrl } from '@hapi/protocol/localServices'
import { LocalServiceManager } from './manager'
import { pathPreviewHeaders, rewritePreviewCss, rewritePreviewHtml, rewritePreviewUrl } from './pathPreview'
import { startLocalServices } from './start'

const preview = {
    origin: 'https://hub.example.com', basePath: '/preview/lease/grant',
    target: parseLocalServiceUrl('http://localhost:8317/')!
}

describe('same-origin sandbox preview policy', () => {
    it('overrides unsafe upstream policies and credentials for every resource type', () => {
        for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/json', 'text/javascript']) {
            const headers = pathPreviewHeaders({
                'content-type': mime, 'content-security-policy': 'sandbox allow-same-origin',
                'set-cookie': ['hapi=override; Path=/'], 'www-authenticate': 'Basic realm="hub"',
                'refresh': '0;url=/api/auth', 'link': '</api/auth>; rel=prefetch',
                'clear-site-data': '"*"', 'access-control-allow-credentials': 'true',
                'strict-transport-security': 'max-age=0', 'accept-ch': 'Sec-CH-UA-Full-Version',
                'cross-origin-embedder-policy': 'credentialless', 'authentication-info': 'nextnonce="upstream"'
            }, preview)
            expect(headers['content-security-policy']).toContain('sandbox allow-scripts allow-forms;')
            expect(headers['content-security-policy']).not.toContain('allow-same-origin')
            expect(headers['content-security-policy']).toContain("worker-src 'none'")
            expect(headers['content-security-policy']).toContain(`connect-src ${preview.origin}${preview.basePath}/ wss://hub.example.com${preview.basePath}/`)
            for (const key of ['set-cookie', 'www-authenticate', 'refresh', 'link', 'clear-site-data', 'access-control-allow-credentials', 'strict-transport-security', 'accept-ch', 'cross-origin-embedder-policy', 'authentication-info']) expect(headers[key]).toBeUndefined()
            expect(headers['content-type']).toBe(mime)
            expect(headers['access-control-allow-origin']).toBe('null')
            expect(headers['cache-control']).toBe('no-store')
        }
    })

    it('rewrites paths and same-target redirects but rejects escapes', () => {
        const scope = preview.origin + preview.basePath
        expect(rewritePreviewUrl('../next?q=1#part', preview, '/dir/page')).toBe(`${scope}/next?q=1#part`)
        expect(rewritePreviewUrl('/api/models', preview, '/')).toBe(`${scope}/api/models`)
        expect(rewritePreviewUrl('http://localhost:8317/next', preview, '/')).toBe(`${scope}/next`)
        for (const url of ['https://evil.example/', '//evil.example/', 'http://localhost:8318/', 'https://hub.example.com/api/auth', 'javascript:alert(1)', 'data:text/html,test', 'http://user@localhost:8317/']) {
            expect(rewritePreviewUrl(url, preview, '/')).toBeNull()
        }
    })

    it('adapts HTML and CSS without allowing base or refresh to bypass the prefix', async () => {
        const html = '<html><head><base href="/"><meta http-equiv="refresh" content="0;url=/api"><link href="/assets/site.css"></head><body><img src="../icon.svg"><form action="/submit"></form><script src="/assets/app.js"></script></body></html>'
        const result = await rewritePreviewHtml(new Response(html), preview, '/dir/index').text()
        expect(result).not.toContain('<base')
        expect(result).not.toContain('http-equiv="refresh"')
        expect(result).toContain(`${preview.origin}${preview.basePath}/assets/site.css`)
        expect(result).toContain(`${preview.origin}${preview.basePath}/icon.svg`)
        expect(result).toContain(`${preview.origin}${preview.basePath}/submit`)
        expect(result).toContain('window.fetch=function')
        expect(rewritePreviewCss('p{background:url(../img.png)} @import "/theme.css";', preview, '/css/main.css'))
            .toBe(`p{background:url("${preview.origin}${preview.basePath}/img.png")} @import "${preview.origin}${preview.basePath}/theme.css";`)
    })

    it('opts in without an origin template and rejects unsafe public origins', async () => {
        expect(await startLocalServices(() => null, 'https://hub.example.com', {})).toBeNull()
        expect(await startLocalServices(() => null, 'https://hub.example.com', { HAPI_LOCAL_SERVICE_MODE: 'off', HAPI_LOCAL_SERVICE_ORIGIN: 'invalid' })).toBeNull()
        await expect(startLocalServices(() => null, 'https://hub.example.com', { HAPI_LOCAL_SERVICE_MODE: 'bad' })).rejects.toThrow('HAPI_LOCAL_SERVICE_MODE')
        const options = {
            mode: 'path' as const, sshHost: 'localhost', sshListenHost: '127.0.0.1', sshPort: 0,
            canAccessMachine: () => true, openTunnel: async () => ({ ok: false as const, error: 'test' })
        }
        expect(new LocalServiceManager({ ...options, appUrl: 'https://hub.example.com' }).mode).toBe('path')
        for (const appUrl of ['http://public.example.com', 'https://hub.example.com/path', 'https://user@hub.example.com']) {
            expect(() => new LocalServiceManager({ ...options, appUrl })).toThrow('HTTPS Hub origin')
        }
    })
})
