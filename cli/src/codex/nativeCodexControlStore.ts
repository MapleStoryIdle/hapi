import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
    NativeCodexSessionConfigurationSchema,
    type NativeCodexSessionConfiguration
} from '@hapi/protocol/codexTranscript'

export type NativeCodexSessionControlState = {
    sessionId: string
    configuration: NativeCodexSessionConfiguration
    queuePaused: boolean
    stoppingTurnId?: string
}

export type NativeCodexSessionControlStore = {
    load: () => NativeCodexSessionControlState[]
    save: (states: readonly NativeCodexSessionControlState[]) => void
}

type NativeCodexSessionControlStoreFile = {
    version: 1
    sessions: NativeCodexSessionControlState[]
}

function parseState(value: unknown): NativeCodexSessionControlState | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : ''
    if (!sessionId || sessionId.length > 512) return null
    const configuration = NativeCodexSessionConfigurationSchema.safeParse(record.configuration ?? {})
    if (!configuration.success || typeof record.queuePaused !== 'boolean') return null
    const stoppingTurnId = typeof record.stoppingTurnId === 'string' && record.stoppingTurnId.trim()
        ? record.stoppingTurnId.trim()
        : undefined
    if (record.stoppingTurnId !== undefined && (!stoppingTurnId || stoppingTurnId.length > 512)) return null
    return {
        sessionId,
        configuration: configuration.data,
        queuePaused: record.queuePaused,
        ...(stoppingTurnId ? { stoppingTurnId } : {})
    }
}

/** HAPI-only controls; never writes Codex's config or transcript files. */
export class FileNativeCodexSessionControlStore implements NativeCodexSessionControlStore {
    constructor(private readonly filePath: string) {}

    load(): NativeCodexSessionControlState[] {
        try {
            const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid native control state')
            const record = parsed as Record<string, unknown>
            if (record.version !== 1 || !Array.isArray(record.sessions)) throw new Error('Invalid native control state')
            const states: NativeCodexSessionControlState[] = []
            const seen = new Set<string>()
            for (const value of record.sessions) {
                const state = parseState(value)
                if (!state || seen.has(state.sessionId)) throw new Error('Invalid native control state row')
                seen.add(state.sessionId)
                states.push(state)
            }
            return states
        } catch (error) {
            if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
            throw error
        }
    }

    save(states: readonly NativeCodexSessionControlState[]): void {
        const parent = dirname(this.filePath)
        mkdirSync(parent, { recursive: true })
        const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`
        const payload: NativeCodexSessionControlStoreFile = {
            version: 1,
            sessions: states.map((state) => ({
                sessionId: state.sessionId,
                configuration: { ...state.configuration },
                queuePaused: state.queuePaused,
                ...(state.stoppingTurnId ? { stoppingTurnId: state.stoppingTurnId } : {})
            }))
        }
        writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
        renameSync(temporaryPath, this.filePath)
    }
}
