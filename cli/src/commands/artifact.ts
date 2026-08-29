import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { initializeToken } from '@/ui/tokenInit'
import type { CommandDefinition } from './types'

const MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_EXPIRES = 86400

function fail(message: string): never {
    throw new Error(message)
}

export async function readArtifactSource(input: string, cwd = process.cwd()): Promise<{ filename: string; bytes: Uint8Array }> {
    if (!input || isAbsolute(input)) fail('Artifact path must be a non-empty relative path.')

    const cwdReal = await realpath(cwd)
    const resolved = resolve(cwd, input)
    if (relative(cwd, resolved).startsWith('..') || relative(cwd, resolved) === '') {
        fail('Artifact path must stay inside the current directory.')
    }

    const before = await lstat(resolved).catch(() => fail('Artifact file not found.'))
    if (before.isSymbolicLink() || !before.isFile()) fail('Artifact source must be a regular non-symlink file.')
    if (before.size > MAX_BYTES) fail('Artifact exceeds 10 MiB.')

    const canonical = await realpath(resolved)
    if (relative(cwdReal, canonical).startsWith('..') || relative(cwdReal, canonical) === '') {
        fail('Artifact path escapes the current directory.')
    }

    const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
    const handle = await open(resolved, flags)
    try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.mtimeMs !== before.mtimeMs) {
            fail('Artifact changed while opening.')
        }

        const bytes = new Uint8Array(opened.size)
        let offset = 0
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) fail('Artifact changed while reading.')
            offset += bytesRead
        }

        const after = await lstat(resolved)
        if (after.isSymbolicLink() || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            fail('Artifact changed while reading.')
        }
        return { filename: basename(canonical).normalize('NFC'), bytes }
    } finally {
        await handle.close()
    }
}

function parseExpires(args: string[]): { path: string; expires: number } {
    const positional: string[] = []
    let expires = DEFAULT_EXPIRES
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--expires') {
            const raw = args[++i]
            if (!raw || !/^\d+$/.test(raw)) fail('--expires must be integer seconds.')
            expires = Number(raw)
        } else {
            positional.push(args[i])
        }
    }
    if (positional.length !== 1 || !Number.isSafeInteger(expires) || expires < 300 || expires > 604800) {
        fail('Usage: hapi artifact publish <relative-file> [--expires 300..604800]')
    }
    return { path: positional[0], expires }
}

function artifactUrl(path: string): string {
    const base = configuration.apiUrl.replace(/\/+$/, '')
    return `${base}/${path.replace(/^\/+/, '')}`
}

async function request(path: string, init: RequestInit): Promise<Response> {
    return fetch(artifactUrl(path), {
        ...init,
        headers: {
            ...configuration.extraHeaders,
            ...init.headers,
            Authorization: `Bearer ${configuration.cliApiToken}`
        }
    })
}

export const artifactCommand: CommandDefinition = {
    name: 'artifact',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await initializeToken()
            const verb = commandArgs[0]
            if (verb === 'publish') {
                const parsed = parseExpires(commandArgs.slice(1))
                const source = await readArtifactSource(parsed.path)
                const filename = Buffer.from(source.filename, 'utf8').toString('base64url')
                const response = await request('cli/artifacts', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-hapi-artifact-filename': filename,
                        'x-hapi-artifact-expires': String(parsed.expires)
                    },
                    body: source.bytes
                })
                if (!response.ok) fail(`Publish failed (${response.status}).`)
                const value = await response.json() as { id: string; url: string; expiresAt: number }
                console.log(`Artifact ${value.id}\n${value.url}\nExpires: ${new Date(value.expiresAt).toISOString()}`)
                return
            }
            if (verb === 'revoke' && commandArgs.length === 2) {
                const response = await request(`cli/artifacts/${encodeURIComponent(commandArgs[1])}`, { method: 'DELETE' })
                if (!response.ok) fail(response.status === 404 ? 'Artifact not found.' : `Revoke failed (${response.status}).`)
                console.log(`Artifact ${commandArgs[1]} revoked.`)
                return
            }
            fail('Usage: hapi artifact publish <relative-file> [--expires <seconds>] | hapi artifact revoke <artifact-id>')
        } catch (error) {
            console.error(error instanceof Error ? error.message : 'Artifact command failed.')
            process.exitCode = 1
        }
    }
}
