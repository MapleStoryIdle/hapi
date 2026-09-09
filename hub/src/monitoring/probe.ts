import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { MonitorRequestSchema, type MonitorRequest } from '@hapi/protocol/monitoring'

const never = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['169.254.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) never.addSubnet(address, prefix)
never.addSubnet('fe80::', 10, 'ipv6')
never.addSubnet('ff00::', 8, 'ipv6')
never.addAddress('::', 'ipv6')
never.addAddress('100.100.100.200')
never.addAddress('168.63.129.16')
const privateAddresses = new BlockList()
for (const [address, prefix] of [['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) privateAddresses.addSubnet(address, prefix)
privateAddresses.addAddress('::1', 'ipv6')
privateAddresses.addSubnet('fc00::', 7, 'ipv6')
privateAddresses.addSubnet('2001:db8::', 32, 'ipv6')

export function probeAddressAllowed(address: string, allowPrivate: boolean): boolean {
    const family = isIP(address)
    if (!family) return false
    const type = family === 6 ? 'ipv6' : 'ipv4'
    if (never.check(address, type)) return false
    if (privateAddresses.check(address, type)) return allowPrivate
    // Reject IPv6 translation/tunneling/special-use ranges, including mapped
    // IPv4, so they cannot bypass the IPv4 network policy.
    if (family === 6 && !/^[23][0-9a-f]{3}:/i.test(address)) return false
    if (family === 6 && /^(2001:0:|2002:)/i.test(address)) return false
    return true
}

export function validateProbeRequest(input: MonitorRequest): URL {
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use an HTTP(S) URL without credentials or a fragment')
    const forbidden = /^(host|connection|upgrade|content-length|transfer-encoding|proxy-.*|trailer|te|cookie2|accept-encoding)$/i
    for (const [key, value] of Object.entries(input.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || forbidden.test(key) || /[\r\n\0]/.test(value)) throw new Error('Unsupported request header')
    }
    if (input.method !== 'POST' && input.body) throw new Error('Request body requires POST')
    if (input.method === 'POST' && !input.allowPost) throw new Error('Repeated POST requests require explicit consent')
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(hostname) && !probeAddressAllowed(hostname, input.allowPrivateNetwork)) throw new Error('This network address is not allowed')
    return url
}

export type ProbeResult = { ok: boolean; latencyMs: number; error: string | null }

export async function runProbe(input: MonitorRequest, parentSignal?: AbortSignal, resolveAddresses: (hostname: string) => Promise<Array<{ address: string; family: number }>> = hostname => lookup(hostname, { all: true })): Promise<ProbeResult> {
    const started = performance.now()
    const signal = parentSignal ? AbortSignal.any([parentSignal, AbortSignal.timeout(input.timeoutSeconds * 1000)]) : AbortSignal.timeout(input.timeoutSeconds * 1000)
    const result = (ok: boolean, error: string | null): ProbeResult => ({ ok, error, latencyMs: Math.round(performance.now() - started) })
    try {
        const url = validateProbeRequest(input)
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        // Pin the verified DNS result into the connection; no second lookup,
        // no redirects, no proxy environment and no credential forwarding.
        const addresses = await Promise.race([
            resolveAddresses(hostname),
            new Promise<never>((_, reject) => {
                if (signal.aborted) reject(new Error('timeout'))
                else signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
            })
        ])
        if (!addresses.length || addresses.some(a => !probeAddressAllowed(a.address, input.allowPrivateNetwork))) return result(false, 'Network address blocked')
        const address = addresses[0]
        const pinnedUrl = new URL(url)
        pinnedUrl.hostname = address.family === 6 ? `[${address.address}]` : address.address
        return await new Promise<ProbeResult>((resolve) => {
            // Bun's node:http compatibility layer does not honor a custom DNS
            // lookup consistently. Use the literal checked IP for the socket,
            // keeping Host and TLS SNI/certificate verification on the original host.
            const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(pinnedUrl, {
                method: input.method, headers: { ...input.headers, Host: url.host, 'Accept-Encoding': 'identity' },
                signal, agent: false, servername: hostname
            }, response => {
                const status = response.statusCode ?? 0
                if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' && input.bodyIncludes) {
                    response.destroy(); resolve(result(false, 'Compressed responses cannot be matched')); return
                }
                if (status !== input.expectedStatus) {
                    response.destroy()
                    resolve(result(false, `HTTP ${status}; expected ${input.expectedStatus}`))
                    return
                }
                if (!input.bodyIncludes) { response.destroy(); resolve(result(true, null)); return }
                let size = 0
                const chunks: Buffer[] = []
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length
                    if (size > 128 * 1024) { response.destroy(); resolve(result(false, 'Response exceeds 128 KB')); return }
                    chunks.push(chunk)
                })
                response.on('end', () => {
                    const matches = Buffer.concat(chunks).toString('utf8').includes(input.bodyIncludes)
                    resolve(result(matches, matches ? null : 'Expected response text was not found'))
                })
                response.on('error', () => resolve(result(false, 'Response interrupted')))
            })
            request.on('error', () => resolve(result(false, signal.aborted ? 'Request timed out or was cancelled' : 'Unable to connect to the service')))
            request.end(input.body || undefined)
        })
    } catch {
        return result(false, signal.aborted ? 'Request timed out or was cancelled' : 'Unable to resolve or access the service')
    }
}

/** Deliberately small curl import grammar: data, not an executable shell. */
export function parseMonitorCurl(command: string): MonitorRequest {
    if (command.length > 16000 || /[`$\0]/.test(command)) throw new Error('Shell expressions are not supported')
    const args: string[] = []
    let token = '', quote = '', escaped = false, active = false
    for (const char of command.replace(/\\\r?\n/g, ' ')) {
        if (escaped) { token += char; escaped = false; active = true; continue }
        if (char === '\\' && quote !== "'") { escaped = true; continue }
        if (quote) { if (char === quote) quote = ''; else token += char; active = true; continue }
        if (char === '"' || char === "'") { quote = char; active = true; continue }
        if (/[;|&<>]/.test(char)) throw new Error('Shell operators are not supported')
        if (/\s/.test(char)) { if (active) { args.push(token); token = ''; active = false }; continue }
        token += char; active = true
    }
    if (quote || escaped) throw new Error('Unclosed curl quotation')
    if (active) args.push(token)
    if (args.shift() !== 'curl') throw new Error('Expected curl')
    let url = '', method = 'GET', body = '', explicitMethod = false
    const headers: Record<string, string> = {}
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (['-s', '-S', '-sS', '--silent', '--show-error'].includes(arg)) continue
        if (arg === '-I' || arg === '--head') { method = 'HEAD'; explicitMethod = true; continue }
        if (['-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--url'].includes(arg)) {
            const value = args[++i]
            if (value === undefined) throw new Error('Missing curl argument')
            if (arg === '-X' || arg === '--request') { method = value.toUpperCase(); explicitMethod = true }
            else if (arg === '-H' || arg === '--header') {
                const colon = value.indexOf(':')
                if (colon <= 0) throw new Error('Invalid header')
                headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim()
            } else if (arg === '--url') { if (url) throw new Error('Only one URL is supported'); url = value }
            else { if (value.startsWith('@')) throw new Error('Local file reads are not supported'); body = value; if (!explicitMethod) method = 'POST' }
        } else if (arg.startsWith('-')) throw new Error('Unsupported curl option; use URL, method, headers and inline body only')
        else { if (url) throw new Error('Only one URL is supported'); url = arg }
    }
    const request = MonitorRequestSchema.parse({ url, method, body, headers })
    // Parsing never sends a request. Consent is required when saving POST.
    validateProbeRequest({ ...request, allowPost: true, allowPrivateNetwork: true })
    return request
}
