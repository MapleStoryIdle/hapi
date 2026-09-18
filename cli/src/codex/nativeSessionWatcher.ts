import { readdirSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { getCodexSessionIdFromTranscriptFilePath } from '@hapi/protocol/codexTranscript'
import { startFileWatcher as defaultStartFileWatcher } from '@/modules/watcher/startFileWatcher'
import { logger } from '@/ui/logger'
import { getCodexHomePath } from './codexHome'

export { getCodexHomePath } from './codexHome'

const DEFAULT_DISCOVERY_INTERVAL_MS = 15_000
const DEFAULT_DEBOUNCE_MS = 120
// `fs.watch()` can consume a file descriptor per transcript on macOS. Poll the
// transcript tree for dormant sessions and reserve file watchers for sessions
// that the browser or active-control path has explicitly observed.
const MAX_OBSERVED_TRANSCRIPTS = 16

export type NativeCodexSessionChange = {
    codexSessionId: string
    filePath: string
    modifiedAt: number
}

export type NativeCodexFileWatcher = (filePath: string, onChange: () => void) => () => void

export type NativeCodexSessionWatcherOptions = {
    onChange: (change: NativeCodexSessionChange) => void
    root?: string
    discoveryIntervalMs?: number
    debounceMs?: number
    watchFile?: NativeCodexFileWatcher
    now?: () => number
    maxObservedTranscripts?: number
}

type TranscriptCandidate = {
    filePath: string
    modifiedAt: number
}

type WatchedTranscript = {
    codexSessionId: string
    modifiedAt: number
}

type PendingChange = {
    filePath: string
    modifiedAt: number
    timer: ReturnType<typeof setTimeout>
}

export function getCodexSessionIdFromTranscriptPath(filePath: string): string | null {
    return getCodexSessionIdFromTranscriptFilePath(filePath)
}

function collectTranscriptFiles(root: string, files: TranscriptCandidate[]): void {
    let entries: Dirent[]
    try {
        entries = readdirSync(root, { withFileTypes: true })
    } catch {
        return
    }

    for (const entry of entries) {
        const filePath = join(root, entry.name)
        if (entry.isDirectory()) {
            collectTranscriptFiles(filePath, files)
            continue
        }
        if (!entry.isFile() || !filePath.toLowerCase().endsWith('.jsonl')) {
            continue
        }
        try {
            files.push({ filePath, modifiedAt: statSync(filePath).mtimeMs })
        } catch {
            // Codex may rotate or remove a transcript while it is discovered.
        }
    }
}

/**
 * Watches runner-local native Codex transcripts and emits only lightweight
 * invalidations. The transcript body stays on the runner and is read through
 * the existing RPC endpoint after the web client receives the event.
 */
export class NativeCodexSessionWatcher {
    private readonly root: string
    private readonly discoveryIntervalMs: number
    private readonly debounceMs: number
    private readonly watchFile: NativeCodexFileWatcher
    private readonly now: () => number
    private readonly onChange: (change: NativeCodexSessionChange) => void
    private readonly maxObservedTranscripts: number
    private readonly discoveredFiles = new Map<string, WatchedTranscript>()
    private readonly observedFiles = new Map<string, WatchedTranscript>()
    private readonly fileWatchStops = new Map<string, () => void>()
    private readonly pendingChanges = new Map<string, PendingChange>()
    private discoveryTimer: ReturnType<typeof setInterval> | null = null
    private started = false
    private initialized = false

    constructor(options: NativeCodexSessionWatcherOptions) {
        this.root = options.root ?? join(getCodexHomePath(), 'sessions')
        this.discoveryIntervalMs = options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
        this.watchFile = options.watchFile ?? defaultStartFileWatcher
        this.now = options.now ?? Date.now
        this.onChange = options.onChange
        this.maxObservedTranscripts = options.maxObservedTranscripts ?? MAX_OBSERVED_TRANSCRIPTS
    }

    start(): void {
        if (this.started) return
        this.started = true
        this.refresh()
        this.discoveryTimer = setInterval(() => this.refresh(), this.discoveryIntervalMs)
        this.discoveryTimer.unref?.()
    }

    stop(): void {
        this.started = false
        this.initialized = false
        if (this.discoveryTimer) {
            clearInterval(this.discoveryTimer)
            this.discoveryTimer = null
        }
        for (const pending of this.pendingChanges.values()) {
            clearTimeout(pending.timer)
        }
        this.pendingChanges.clear()
        for (const stop of this.fileWatchStops.values()) {
            stop()
        }
        this.fileWatchStops.clear()
        this.discoveredFiles.clear()
        this.observedFiles.clear()
    }

    /**
     * Elevate a transcript currently visible in a browser detail view. This
     * preserves low-latency updates even if a user reopens an older thread
     * that has not yet returned to the recent transcript window.
     */
    observeTranscript(filePath: string, codexSessionId: string): void {
        if (getCodexSessionIdFromTranscriptPath(filePath) !== codexSessionId) {
            return
        }

        let modifiedAt = this.now()
        try {
            modifiedAt = statSync(filePath).mtimeMs
        } catch {
            return
        }

        const previous = this.observedFiles.get(filePath)
        if (previous?.codexSessionId === codexSessionId && previous.modifiedAt === modifiedAt) {
            // Refresh LRU order when an open detail view touches the same file.
            this.observedFiles.delete(filePath)
            this.observedFiles.set(filePath, previous)
            return
        }
        this.observedFiles.delete(filePath)
        this.observedFiles.set(filePath, { codexSessionId, modifiedAt })
        while (this.observedFiles.size > this.maxObservedTranscripts) {
            const oldestPath = this.observedFiles.keys().next().value
            if (!oldestPath) break
            this.observedFiles.delete(oldestPath)
            this.stopWatchingFile(oldestPath)
        }

        if (this.started) {
            this.refresh()
        }
    }

    private refresh(): void {
        if (!this.started) return

        const candidates: TranscriptCandidate[] = []
        collectTranscriptFiles(this.root, candidates)
        candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.filePath.localeCompare(right.filePath))
        const candidatesByPath = new Map(candidates.map((candidate) => [candidate.filePath, candidate]))

        const previous = new Map(this.discoveredFiles)
        const next = new Map<string, WatchedTranscript>()
        for (const candidate of candidates) {
            const codexSessionId = getCodexSessionIdFromTranscriptPath(candidate.filePath)
            if (!codexSessionId) continue
            next.set(candidate.filePath, { codexSessionId, modifiedAt: candidate.modifiedAt })
        }
        for (const [filePath, observed] of this.observedFiles) {
            const candidate = candidatesByPath.get(filePath)
            if (!candidate) {
                this.observedFiles.delete(filePath)
                continue
            }
            this.observedFiles.set(filePath, { ...observed, modifiedAt: candidate.modifiedAt })
        }
        this.discoveredFiles.clear()
        for (const [filePath, transcript] of next) {
            this.discoveredFiles.set(filePath, transcript)
        }

        for (const [filePath, previousTranscript] of previous) {
            if (!next.has(filePath)) {
                this.scheduleChange(previousTranscript.codexSessionId, filePath, this.now())
                this.stopWatchingFile(filePath)
            }
        }

        for (const [filePath, transcript] of next) {
            const previousTranscript = previous.get(filePath)
            if (this.observedFiles.has(filePath) && !this.fileWatchStops.has(filePath)) {
                this.startWatchingFile(filePath)
            }
            if (this.initialized && (!previousTranscript || transcript.modifiedAt > previousTranscript.modifiedAt)) {
                this.scheduleChange(transcript.codexSessionId, filePath, transcript.modifiedAt)
            }
        }

        for (const filePath of this.fileWatchStops.keys()) {
            if (!this.observedFiles.has(filePath)) {
                this.stopWatchingFile(filePath)
            }
        }

        this.initialized = true
    }

    private startWatchingFile(filePath: string): void {
        try {
            const stop = this.watchFile(filePath, () => this.handleFileChange(filePath))
            this.fileWatchStops.set(filePath, stop)
        } catch (error) {
            logger.debug('[native-codex-watcher] Failed to watch transcript', {
                filePath,
                error: error instanceof Error ? error.message : String(error)
            })
        }
    }

    private stopWatchingFile(filePath: string): void {
        const stop = this.fileWatchStops.get(filePath)
        if (!stop) return
        stop()
        this.fileWatchStops.delete(filePath)
    }

    private handleFileChange(filePath: string): void {
        if (!this.started) return
        const transcript = this.discoveredFiles.get(filePath)
        if (!transcript) {
            this.refresh()
            return
        }

        let modifiedAt = this.now()
        try {
            modifiedAt = statSync(filePath).mtimeMs
        } catch {
            // A rename/delete still needs to invalidate the list and detail.
        }
        // Keep discovery's baseline in sync with the file watcher. Otherwise
        // the next directory scan would see this same mtime as a second
        // change and emit a duplicate invalidation a few seconds later.
        this.discoveredFiles.set(filePath, { ...transcript, modifiedAt })
        if (this.observedFiles.has(filePath)) {
            this.observedFiles.set(filePath, { ...transcript, modifiedAt })
        }
        this.scheduleChange(transcript.codexSessionId, filePath, modifiedAt)
    }

    private scheduleChange(codexSessionId: string, filePath: string, modifiedAt: number): void {
        const previous = this.pendingChanges.get(codexSessionId)
        if (previous) {
            clearTimeout(previous.timer)
        }

        const pending: PendingChange = {
            filePath,
            modifiedAt,
            timer: setTimeout(() => {
                this.pendingChanges.delete(codexSessionId)
                if (!this.started) return
                this.onChange({ codexSessionId, filePath: pending.filePath, modifiedAt: pending.modifiedAt })
            }, this.debounceMs)
        }
        pending.timer.unref?.()
        this.pendingChanges.set(codexSessionId, pending)
    }
}
