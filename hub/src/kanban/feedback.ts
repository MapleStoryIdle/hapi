import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeedbackMetadata, Store } from '../store'

export const MAX_KANBAN_FEEDBACK_BYTES = 10 * 1024 * 1024
const UPLOAD_LEASE_MS = 2 * 60 * 1000
const MARKDOWN_FILENAME = /^[^/\\\u0000-\u001f\u007f]+\.(?:md|markdown)$/i

function sha256(value: Uint8Array | string): string {
    return createHash('sha256').update(value).digest('hex')
}

export function isMarkdownFilename(filename: string): boolean {
    return MARKDOWN_FILENAME.test(filename)
}

/** Keep task IDs out of filesystem paths and make a corrupted blob detectable. */
export function feedbackBlobPath(dataDir: string, artifactId: string): string {
    return join(dataDir, 'kanban-feedback', `${sha256(artifactId)}.md`)
}

function scalar(value: string): string | null {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null
    const quoted = /^(?:"([^"]*)"|'([^']*)')$/.exec(trimmed)
    const result = quoted ? (quoted[1] ?? quoted[2]) : trimmed
    return result && !/[\u0000-\u001f\u007f]/.test(result) ? result : null
}

/**
 * Deliberately small front-matter parser. The public feedback contract only
 * needs scalar self-reported metadata, so accepting arbitrary YAML would add
 * parsing surface without any product benefit.
 */
export function parseFeedbackMetadata(bytes: Uint8Array): FeedbackMetadata | null {
    if (bytes.length === 0 || bytes.length > MAX_KANBAN_FEEDBACK_BYTES) return null

    let text: string
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        return null
    }
    if (text.includes('\u0000')) return null

    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    if (lines[0] !== '---') return null
    const end = lines.slice(1, 81).findIndex((line) => line === '---')
    if (end < 0) return null

    const fields: Record<string, Record<string, string>> = {
        root: {},
        agent: {},
        model: {},
        environment: {}
    }
    let section: keyof typeof fields = 'root'
    for (const line of lines.slice(1, end + 1)) {
        if (!line || /^\s*#/.test(line)) continue
        const top = /^([a-z_]+):\s*(.*)$/.exec(line)
        if (top) {
            const [, key, raw] = top
            if (key === 'agent' || key === 'model' || key === 'environment') {
                if (raw) return null
                section = key
                continue
            }
            if (section !== 'root') return null
            const value = scalar(raw)
            if (!value) return null
            fields.root[key] = value
            continue
        }

        const nested = /^ {2}([a-z_]+):\s*(.*)$/.exec(line)
        if (!nested || section === 'root') return null
        const value = scalar(nested[2])
        if (!value) return null
        fields[section][nested[1]] = value
    }

    if (fields.root.hapi_feedback !== '1') return null
    const agent = fields.agent
    const model = fields.model
    const environment = fields.environment
    if (!agent.name || !agent.version || !model.provider || !model.id || !environment.os || !environment.arch || !environment.runtime) {
        return null
    }
    return {
        agent: { name: agent.name, version: agent.version },
        model: {
            provider: model.provider,
            id: model.id,
            reasoningEffort: model.reasoning_effort ?? null
        },
        environment: {
            os: environment.os,
            arch: environment.arch,
            runtime: environment.runtime
        }
    }
}

export class KanbanFeedbackService {
    private readonly dir: string

    constructor(private readonly store: Store, private readonly dataDir: string) {
        this.dir = join(dataDir, 'kanban-feedback')
        mkdirSync(this.dir, { recursive: true, mode: 0o700 })
        try {
            chmodSync(this.dir, 0o700)
        } catch {
        }
    }

    receive(input: {
        artifactId: string
        token: string
        filename: string
        bytes: Uint8Array
        metadata: FeedbackMetadata
    }): boolean {
        if (!isMarkdownFilename(input.filename) || input.bytes.length > MAX_KANBAN_FEEDBACK_BYTES) return false

        const claim = this.store.kanbanTasks.claimFeedbackUpload({
            artifactId: input.artifactId,
            tokenHash: sha256(input.token),
            leaseMs: UPLOAD_LEASE_MS
        })
        if (!claim) return false

        const target = feedbackBlobPath(this.dataDir, input.artifactId)
        const temp = join(this.dir, `.${sha256(input.artifactId)}.${claim.leaseId}.tmp`)
        try {
            writeFileSync(temp, input.bytes, { mode: 0o600, flag: 'wx' })
            try {
                chmodSync(temp, 0o600)
            } catch {
            }
            renameSync(temp, target)
            const completed = this.store.kanbanTasks.completeFeedbackUpload({
                artifactId: input.artifactId,
                leaseId: claim.leaseId,
                filename: input.filename,
                size: input.bytes.length,
                sha256: sha256(input.bytes),
                metadata: input.metadata
            })
            if (completed) return true
            rmSync(target, { force: true })
        } catch {
            try {
                rmSync(temp, { force: true })
                rmSync(target, { force: true })
            } catch {
            }
        }

        this.store.kanbanTasks.releaseFeedbackUpload(input.artifactId, claim.leaseId)
        return false
    }

    read(artifactId: string): { bytes: Uint8Array; metadata: FeedbackMetadata; filename: string; receivedAt: number } | null {
        const task = this.store.kanbanTasks.find(artifactId)
        if (!task || (task.status !== 'feedback_received' && task.status !== 'review_sending' && task.status !== 'review_sent') || !task.feedbackMetadata || !task.feedbackFilename || !task.feedbackSha256 || !task.feedbackReceivedAt) {
            return null
        }
        const path = feedbackBlobPath(this.dataDir, artifactId)
        if (!existsSync(path)) return null
        try {
            const bytes = readFileSync(path)
            if (bytes.length !== task.feedbackSize || sha256(bytes) !== task.feedbackSha256) return null
            return {
                bytes,
                metadata: task.feedbackMetadata,
                filename: task.feedbackFilename,
                receivedAt: task.feedbackReceivedAt
            }
        } catch {
            return null
        }
    }

    remove(artifactId: string): void {
        try {
            rmSync(feedbackBlobPath(this.dataDir, artifactId), { force: true })
        } catch {
        }
    }
}
