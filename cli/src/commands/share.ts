import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { configuration } from '@/configuration'
import { initializeToken } from '@/ui/tokenInit'
import { getInvokedCwd } from '@/utils/invokedCwd'
import type { ShareSourceContext } from '@hapi/protocol/apiTypes'
import type { CommandDefinition } from './types'

const MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_EXPIRES = 86400
const MAX_SOURCE_CONTEXT_BYTES = 255
const GIT_BRANCH_TIMEOUT_MS = 1000
const execFileAsync = promisify(execFile)

function fail(message: string): never {
    throw new Error(message)
}

export async function readShareSource(input: string, cwd = process.cwd()): Promise<{ filename: string; bytes: Uint8Array }> {
    if (!input || isAbsolute(input)) fail('Share path must be a non-empty relative path.')

    const cwdReal = await realpath(cwd)
    const resolved = resolve(cwd, input)
    if (relative(cwd, resolved).startsWith('..') || relative(cwd, resolved) === '') {
        fail('Share path must stay inside the current directory.')
    }

    const before = await lstat(resolved).catch(() => fail('Share file not found.'))
    if (before.isSymbolicLink() || !before.isFile()) fail('Share source must be a regular non-symlink file.')
    if (before.size > MAX_BYTES) fail('Share exceeds 10 MiB.')

    const canonical = await realpath(resolved)
    if (relative(cwdReal, canonical).startsWith('..') || relative(cwdReal, canonical) === '') {
        fail('Share path escapes the current directory.')
    }

    const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW
    const handle = await open(resolved, flags)
    try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.mtimeMs !== before.mtimeMs) {
            fail('Share changed while opening.')
        }

        const bytes = new Uint8Array(opened.size)
        let offset = 0
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
            if (bytesRead === 0) fail('Share changed while reading.')
            offset += bytesRead
        }

        const after = await lstat(resolved)
        if (after.isSymbolicLink() || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
            fail('Share changed while reading.')
        }
        return { filename: basename(canonical).normalize('NFC'), bytes }
    } finally {
        await handle.close()
    }
}

function isSafeSourceContextText(value: string): boolean {
    return value.length > 0
        && Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_CONTEXT_BYTES
        && !/[\u0000-\u001f\u007f]/.test(value)
}

async function getGitBranch(cwd: string): Promise<string | null> {
    try {
        const env = { ...process.env }
        delete env.GIT_DIR
        delete env.GIT_COMMON_DIR
        delete env.GIT_WORK_TREE
        delete env.GIT_PREFIX
        delete env.GIT_CEILING_DIRECTORIES
        const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
            cwd,
            env,
            encoding: 'utf8',
            timeout: GIT_BRANCH_TIMEOUT_MS,
            maxBuffer: MAX_SOURCE_CONTEXT_BYTES + 2
        })
        const branch = stdout.trim().normalize('NFC')
        return isSafeSourceContextText(branch) ? branch : null
    } catch {
        return null
    }
}

export async function getShareSourceContext(cwd = getInvokedCwd()): Promise<ShareSourceContext | null> {
    const directoryName = basename(cwd).normalize('NFC')
    if (!isSafeSourceContextText(directoryName) || /[\\/]/.test(directoryName) || directoryName === '.' || directoryName === '..') {
        return null
    }
    return { directoryName, gitBranch: await getGitBranch(cwd) }
}

export function encodeShareSourceContextHeaders(sourceContext: ShareSourceContext): Record<string, string> {
    const directory = Buffer.from(sourceContext.directoryName, 'utf8').toString('base64url')
    const branch = sourceContext.gitBranch
        ? Buffer.from(sourceContext.gitBranch, 'utf8').toString('base64url')
        : null
    return {
        'x-hapi-share-source-directory': directory,
        ...(branch ? { 'x-hapi-share-source-branch': branch } : {})
    }
}

type PublishShareOptions = {
    path: string
    expires: number
    sourceSessionId: string | null
    sourceMachineId: string | null
    feedback: boolean
    feedbackRequest: string | null
}

export function parseSharePublishOptions(args: string[], inheritedSessionId?: string | null): PublishShareOptions {
    const positional: string[] = []
    let expires = DEFAULT_EXPIRES
    let sourceSessionId: string | null = null
    let sourceMachineId: string | null = null
    let feedback = false
    let feedbackRequest: string | null = null
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--expires') {
            const raw = args[++i]
            if (!raw || !/^\d+$/.test(raw)) fail('--expires must be integer seconds.')
            expires = Number(raw)
        } else if (args[i] === '--session') {
            const value = args[++i]?.trim()
            if (!value || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) fail('--session must be a session ID.')
            sourceSessionId = value
        } else if (args[i] === '--machine') {
            const value = args[++i]?.trim()
            if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail('--machine must be a machine ID.')
            sourceMachineId = value
        } else if (args[i] === '--feedback') {
            feedback = true
        } else if (args[i] === '--feedback-request') {
            const value = args[++i]?.trim()
            if (!value || value.length > 2000 || /[\u0000\r\n]/.test(value)) fail('--feedback-request must be one line, up to 2000 characters.')
            feedbackRequest = value
        } else {
            positional.push(args[i])
        }
    }
    if (positional.length !== 1 || !Number.isSafeInteger(expires) || expires < 300 || expires > 604800) {
        fail('Usage: hapi share publish <relative-file> [--expires 300..604800] [--session <session-id>] [--machine <machine-id>] [--feedback] [--feedback-request <text>]')
    }
    const inherited = inheritedSessionId?.trim() || null
    if (!sourceSessionId && inherited) {
        if (inherited.length > 255 || /[\u0000-\u001f\u007f]/.test(inherited)) fail('Inherited HAPI session ID is invalid.')
        sourceSessionId = inherited
    }
    if (feedbackRequest && !feedback) fail('--feedback-request requires --feedback.')
    if (sourceMachineId && !sourceSessionId) fail('--machine requires --session <session-id>.')
    if (feedback && !sourceSessionId) fail('--feedback requires --session <session-id>.')
    return { path: positional[0], expires, sourceSessionId, sourceMachineId, feedback, feedbackRequest }
}

function shareUrl(path: string): string {
    const base = configuration.apiUrl.replace(/\/+$/, '')
    return `${base}/${path.replace(/^\/+/, '')}`
}

async function request(path: string, init: RequestInit): Promise<Response> {
    return fetch(shareUrl(path), {
        ...init,
        headers: {
            ...configuration.extraHeaders,
            ...init.headers,
            Authorization: `Bearer ${configuration.cliApiToken}`
        }
    })
}

export const shareCommand: CommandDefinition = {
    name: 'share',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await initializeToken()
            const verb = commandArgs[0]
            if (verb === 'publish') {
                const parsed = parseSharePublishOptions(commandArgs.slice(1), process.env.HAPI_SESSION_ID)
                const invokedCwd = getInvokedCwd()
                const source = await readShareSource(parsed.path, invokedCwd)
                const sourceContext = await getShareSourceContext(invokedCwd)
                if (parsed.feedback && !/\.(?:md|markdown)$/i.test(source.filename)) {
                    fail('--feedback is only supported for Markdown files.')
                }
                const filename = Buffer.from(source.filename, 'utf8').toString('base64url')
                const sourceSession = parsed.sourceSessionId
                    ? Buffer.from(parsed.sourceSessionId, 'utf8').toString('base64url')
                    : null
                const sourceMachine = parsed.sourceMachineId
                    ? Buffer.from(parsed.sourceMachineId, 'utf8').toString('base64url')
                    : null
                const feedbackRequest = parsed.feedbackRequest
                    ? Buffer.from(parsed.feedbackRequest, 'utf8').toString('base64url')
                    : null
                const response = await request('cli/shares', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-hapi-share-filename': filename,
                        'x-hapi-share-expires': String(parsed.expires),
                        ...(sourceContext ? encodeShareSourceContextHeaders(sourceContext) : {}),
                        ...(sourceSession ? { 'x-hapi-share-source-session': sourceSession } : {}),
                        ...(sourceMachine ? { 'x-hapi-share-source-machine': sourceMachine } : {}),
                        ...(parsed.feedback ? { 'x-hapi-share-feedback': '1' } : {}),
                        ...(feedbackRequest ? { 'x-hapi-share-feedback-request': feedbackRequest } : {})
                    },
                    body: source.bytes
                })
                if (!response.ok) {
                    const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
                    const detail = typeof body?.error === 'string' ? body.error : null
                    const code = typeof body?.code === 'string' ? ` (${body.code})` : ''
                    fail(detail ? `Share failed${code}: ${detail}` : `Share failed (${response.status}).`)
                }
                const value = await response.json() as { id: string; url: string; expiresAt: number }
                console.log(`Kanban task ${value.id}\n${value.url}\nExpires: ${new Date(value.expiresAt).toISOString()}${parsed.feedback ? '\nFeedback: enabled (one-time token embedded in the shared Markdown)' : ''}`)
                return
            }
            if (verb === 'revoke' && commandArgs.length === 2) {
                const response = await request(`cli/shares/${encodeURIComponent(commandArgs[1])}`, { method: 'DELETE' })
                if (!response.ok) {
                    const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null
                    const detail = typeof body?.error === 'string' ? body.error : null
                    const code = typeof body?.code === 'string' ? ` (${body.code})` : ''
                    fail(response.status === 404
                        ? 'Share not found.'
                        : detail
                            ? `Revoke failed${code}: ${detail}`
                            : `Revoke failed (${response.status}).`)
                }
                const value = await response.json() as { ok?: boolean; cleanupPending?: boolean }
                if (!value.ok) fail('Revoke failed.')
                console.log(value.cleanupPending
                    ? `Share ${commandArgs[1]} revoked; file cleanup pending.`
                    : `Share ${commandArgs[1]} revoked.`)
                return
            }
            fail('Usage: hapi share publish <relative-file> [--expires <seconds>] [--session <session-id>] [--machine <machine-id>] [--feedback] [--feedback-request <text>] | hapi share revoke <share-id>')
        } catch (error) {
            console.error(error instanceof Error ? error.message : 'Share command failed.')
            process.exitCode = 1
        }
    }
}
