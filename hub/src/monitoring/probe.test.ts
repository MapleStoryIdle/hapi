import { describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { MonitorRequestSchema } from '@hapi/protocol/monitoring'
import { parseMonitorCurl, probeAddressAllowed, runProbe, validateProbeRequest } from './probe'

describe('monitor HTTP safety', () => {
    it('blocks private, metadata, mapped and special addresses by default', () => {
        for (const ip of ['127.0.0.1', '10.2.3.4', '172.20.1.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fe80::1', 'ff02::1', '0.0.0.0', '100.100.100.200']) expect(probeAddressAllowed(ip, false)).toBe(false)
        for (const ip of ['169.254.169.254', '100.100.100.200', '168.63.129.16', 'fe80::1', '::', '224.0.0.1']) expect(probeAddressAllowed(ip, true)).toBe(false)
        expect(probeAddressAllowed('127.0.0.1', true)).toBe(true)
        expect(probeAddressAllowed('8.8.8.8', false)).toBe(true)
        expect(probeAddressAllowed('2606:4700:4700::1111', false)).toBe(true)
    })
    it('imports curl as data without granting private network or POST consent', () => {
        const config = parseMonitorCurl("curl -X POST -H 'Content-Type: application/json' --data-raw '{\"check\":true}' http://127.0.0.1:8317/health")
        expect(config).toMatchObject({ method: 'POST', body: '{"check":true}', allowPost: false, allowPrivateNetwork: false })
        expect(() => validateProbeRequest(config)).toThrow()
        for (const cmd of ['curl https://example.com; whoami', 'curl $(whoami)', 'curl --data @/etc/passwd https://example.com', 'curl -L https://example.com', 'curl https://example.com https://another.example']) expect(() => parseMonitorCurl(cmd)).toThrow()
    })
    it('rejects credential URLs, transport headers and accidental POST', () => {
        for (const change of [{ url: 'https://a:b@example.com' }, { headers: { Host: 'private' } }, { headers: { Authorization: 'x\r\nHost: bad' } }, { method: 'POST' }, { body: 'hello' }]) {
            expect(() => validateProbeRequest(MonitorRequestSchema.parse({ url: 'https://example.com', ...change }))).toThrow()
        }
    })
    it('checks a consented local endpoint and never follows redirects', async () => {
        let secretHits = 0
        const server = createServer((req, res) => {
            if (req.url === '/redirect') { res.writeHead(302, { Location: '/secret' }); res.end(); return }
            if (req.url === '/secret') secretHits++
            res.end('healthy')
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const port = (server.address() as { port: number }).port
        try {
            const request = MonitorRequestSchema.parse({ url: `http://127.0.0.1:${port}`, allowPrivateNetwork: true, bodyIncludes: 'healthy' })
            expect((await runProbe(request)).ok).toBe(true)
            expect((await runProbe({ ...request, url: request.url + '/redirect' })).ok).toBe(false)
            expect(secretHits).toBe(0)
            expect((await runProbe({ ...request, bodyIncludes: 'missing' })).ok).toBe(false)
            // The real Bun HTTP connection must use the verified address, not
            // perform another DNS lookup of this intentionally nonexistent host.
            expect((await runProbe({ ...request, url: `http://monitor-fixture.invalid:${port}` }, undefined,
                async () => [{ address: '127.0.0.1', family: 4 }])).ok).toBe(true)
            expect((await runProbe({ ...request, url: `http://monitor-fixture.invalid:${port}`, allowPrivateNetwork: false }, undefined,
                async () => [{ address: '127.0.0.1', family: 4 }])).error).toBe('Network address blocked')
        } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    })
})
