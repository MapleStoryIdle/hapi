import { expect, it } from 'bun:test'
import { createWebReaderRoutes } from './webReader'

it('returns reader data with no-store and never passes client credentials to the reader', async () => {
    let args: unknown[] = []
    const app = createWebReaderRoutes(async (...input) => { args = input; return { mode: 'embed' } })
    const response = await app.request('/web-reader', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'private=value', Authorization: 'Bearer secret', Origin: 'https://hapi.test' }, body: JSON.stringify({ url: 'https://example.com' }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(args[0]).toBe('https://example.com')
    expect(args[1]).toBe('https://hapi.test')
    expect(JSON.stringify(args)).not.toMatch(/secret|private=value/)
})

it('returns a safe error without internal network details', async () => {
    const app = createWebReaderRoutes(async () => { throw new Error('secret internal host') })
    const response = await app.request('/web-reader', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com' }) })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('secret')
})
