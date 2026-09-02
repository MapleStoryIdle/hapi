import { readFile } from 'node:fs/promises'
import type { ExternalCodexRequestKind, ExternalCodexRequestPayload } from '@hapi/protocol'
import type { ExternalCodexLifecycleEvent } from '@/codex/nativeTurnLifecycle'
import { isProcessAlive } from '@/utils/process'

type ExternalCodexRequest = Omit<ExternalCodexRequestPayload, 'machineId'>

type ExternalCodexHookForwarderOptions = {
    kind: ExternalCodexRequestKind
    phase: 'requested' | 'resolved'
    runnerStatePath: string
}

type ExternalCodexLifecycleHookForwarderOptions = {
    runnerStatePath: string
}

type RunnerControlState = {
    pid: number
    httpPort: number
}

const LIFECYCLE_HOOK_TIMEOUT_MS = 500

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function asNonEmptyString(value: unknown, maximumLength: number): string | null {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return normalized.length > 0 && normalized.length <= maximumLength ? normalized : null
}

function valueFrom(record: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined) {
            return record[key]
        }
    }
    return undefined
}

export function parseExternalCodexHookForwarderOptions(args: string[]): ExternalCodexHookForwarderOptions | null {
    if (!args.includes('--external-codex-request')) {
        return null
    }

    let kind: ExternalCodexRequestKind | null = null
    let phase: 'requested' | 'resolved' = 'requested'
    let runnerStatePath: string | null = null
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]
        if (arg === '--kind') {
            const value = args[index + 1]
            if (value === 'permission' || value === 'user-input') {
                kind = value
            }
            index += 1
            continue
        }
        if (arg === '--runner-state') {
            runnerStatePath = asNonEmptyString(args[index + 1], 4_000)
            index += 1
            continue
        }
        if (arg === '--phase') {
            const value = args[index + 1]
            if (value === 'requested' || value === 'resolved') {
                phase = value
            }
            index += 1
        }
    }

    return kind && runnerStatePath ? { kind, phase, runnerStatePath } : null
}

export function parseExternalCodexLifecycleHookForwarderOptions(
    args: string[]
): ExternalCodexLifecycleHookForwarderOptions | null {
    if (!args.includes('--external-codex-lifecycle')) {
        return null
    }

    let runnerStatePath: string | null = null
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] !== '--runner-state') continue
        runnerStatePath = asNonEmptyString(args[index + 1], 4_000)
        index += 1
    }
    return runnerStatePath ? { runnerStatePath } : null
}

/**
 * Convert the stable, documented subset of Codex hook input into an alert.
 * Do not forward tool_input: it may contain a shell command or other secret.
 */
export function parseExternalCodexHookRequest(
    kind: ExternalCodexRequestKind,
    value: unknown,
    now: () => number = () => Date.now(),
    phase: 'requested' | 'resolved' = 'requested'
): ExternalCodexRequest | null {
    const record = asRecord(value)
    if (!record) return null

    const codexSessionId = asNonEmptyString(valueFrom(record, 'session_id', 'sessionId'), 200)
    if (!codexSessionId) return null

    const toolName = asNonEmptyString(valueFrom(record, 'tool_name', 'toolName'), 200) ?? undefined
    const toolUseId = asNonEmptyString(valueFrom(record, 'tool_use_id', 'toolUseId'), 200)
    const turnId = asNonEmptyString(valueFrom(record, 'turn_id', 'turnId'), 200)
    const observedAt = Math.floor(now())
    if (!Number.isFinite(observedAt) || observedAt < 0) return null
    const requestId = toolUseId
        ?? (turnId ? `${turnId}:${toolName ?? kind}` : `${kind}:${toolName ?? 'unknown'}:${observedAt}`)

    return {
        codexSessionId,
        requestId,
        kind,
        phase,
        ...(toolName ? { toolName } : {}),
        ...(turnId ? { turnId } : {}),
        observedAt
    }
}

/**
 * Reduce UserPromptSubmit input to turn routing metadata. In particular, do
 * not leak the prompt, cwd, model, transcript path, or any raw hook field.
 */
export function parseExternalCodexLifecycleHookEvent(
    value: unknown,
    now: () => number = () => Date.now()
): ExternalCodexLifecycleEvent | null {
    const record = asRecord(value)
    if (!record) return null

    const codexSessionId = asNonEmptyString(valueFrom(record, 'session_id', 'sessionId'), 200)
    const turnId = asNonEmptyString(valueFrom(record, 'turn_id', 'turnId'), 200)
    if (!codexSessionId || !turnId) return null

    const observedAt = Math.floor(now())
    if (!Number.isFinite(observedAt) || observedAt < 0) return null
    return {
        codexSessionId,
        turnId,
        event: 'turn_started',
        observedAt
    }
}

async function readHookInput(): Promise<unknown | null> {
    try {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
        }
        const text = Buffer.concat(chunks).toString('utf-8').trim()
        return text ? JSON.parse(text) : null
    } catch {
        return null
    }
}

async function readRunnerControlState(path: string): Promise<RunnerControlState | null> {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
        const record = asRecord(parsed)
        const pid = record?.pid
        const httpPort = record?.httpPort
        if (
            typeof pid !== 'number'
            || !Number.isInteger(pid)
            || pid <= 0
            || typeof httpPort !== 'number'
            || !Number.isInteger(httpPort)
            || httpPort < 1
            || httpPort > 65_535
        ) {
            return null
        }
        return { pid, httpPort }
    } catch {
        return null
    }
}

/**
 * Invoked by a globally configured Codex hook. It intentionally succeeds
 * silently when the local HAPI runner is absent so a notification outage can
 * never interfere with Codex's normal approval flow.
 */
export async function runExternalCodexHookForwarder(args: string[]): Promise<void> {
    try {
        const options = parseExternalCodexHookForwarderOptions(args)
        if (!options) return

        const request = parseExternalCodexHookRequest(
            options.kind,
            await readHookInput(),
            () => Date.now(),
            options.phase
        )
        if (!request) return

        const runnerState = await readRunnerControlState(options.runnerStatePath)
        if (!runnerState || !isProcessAlive(runnerState.pid)) return

        await fetch(`http://127.0.0.1:${runnerState.httpPort}/codex-external-request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(2_500)
        }).catch(() => undefined)
    } catch {
        // This is an advisory hook. Never surface a hook failure to Codex.
    }
}

/**
 * Invoked by UserPromptSubmit. It is separate from external-codex-request so
 * a native turn start never creates an approval/request push notification.
 */
export async function runExternalCodexLifecycleHookForwarder(args: string[]): Promise<void> {
    try {
        const options = parseExternalCodexLifecycleHookForwarderOptions(args)
        if (!options) return

        const event = parseExternalCodexLifecycleHookEvent(await readHookInput())
        if (!event) return

        const runnerState = await readRunnerControlState(options.runnerStatePath)
        if (!runnerState || !isProcessAlive(runnerState.pid)) return

        await fetch(`http://127.0.0.1:${runnerState.httpPort}/codex-external-lifecycle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
            // UserPromptSubmit is on the interactive path. A delayed local
            // signal is safe (the turn/tombstone logic handles it), but it
            // must not make entering a prompt feel blocked.
            signal: AbortSignal.timeout(LIFECYCLE_HOOK_TIMEOUT_MS)
        }).catch(() => undefined)
    } catch {
        // This is an advisory hook. Never surface a hook failure to Codex.
    }
}
