import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type { ShareSource, ShareSourceContext } from '@hapi/protocol/apiTypes'
import type { FeedbackMetadata, KanbanTaskStatus, StoredKanbanTask } from './types'

type KanbanTaskRow = {
    artifact_id: string
    namespace: string
    source_session_id: string | null
    source_type: 'hapi' | 'native-codex' | null
    source_machine_id: string | null
    source_codex_session_id: string | null
    source_directory_name: string | null
    source_git_branch: string | null
    status: KanbanTaskStatus
    feedback_request: string | null
    feedback_token_hash: string | null
    feedback_lease_id: string | null
    feedback_lease_expires_at: number | null
    feedback_filename: string | null
    feedback_size: number | null
    feedback_sha256: string | null
    feedback_metadata: string | null
    feedback_received_at: number | null
    review_delivered_at: number | null
    created_at: number
    updated_at: number
}

function parseMetadata(value: string | null): FeedbackMetadata | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value) as FeedbackMetadata
        return parsed
    } catch {
        return null
    }
}

function row(value: KanbanTaskRow): StoredKanbanTask {
    const source: ShareSource | null = value.source_type === 'native-codex'
        && value.source_machine_id
        && value.source_codex_session_id
        ? {
            type: 'native-codex',
            machineId: value.source_machine_id,
            codexSessionId: value.source_codex_session_id
        }
        : value.source_session_id
            ? { type: 'hapi', sessionId: value.source_session_id }
            : null
    return {
        artifactId: value.artifact_id,
        namespace: value.namespace,
        source,
        sourceContext: value.source_directory_name
            ? { directoryName: value.source_directory_name, gitBranch: value.source_git_branch }
            : null,
        status: value.status,
        feedbackRequest: value.feedback_request,
        feedbackTokenHash: value.feedback_token_hash,
        feedbackLeaseId: value.feedback_lease_id,
        feedbackLeaseExpiresAt: value.feedback_lease_expires_at,
        feedbackFilename: value.feedback_filename,
        feedbackSize: value.feedback_size,
        feedbackSha256: value.feedback_sha256,
        feedbackMetadata: parseMetadata(value.feedback_metadata),
        feedbackReceivedAt: value.feedback_received_at,
        reviewDeliveredAt: value.review_delivered_at,
        createdAt: value.created_at,
        updatedAt: value.updated_at
    }
}

export type CreateKanbanTaskInput = {
    artifactId: string
    namespace: string
    source?: ShareSource | null
    sourceContext?: ShareSourceContext | null
    feedbackRequest?: string | null
    feedbackTokenHash?: string | null
    createdAt?: number
}

/**
 * Database-only state transitions for a public Kanban feedback task.
 *
 * The short upload lease makes a one-time feedback token atomic even with
 * multiple concurrent POSTs. Invalid uploads are released by the caller, so
 * a malformed document cannot burn a valid feedback request.
 */
export class KanbanTaskStore {
    constructor(private readonly db: Database) {}

    create(input: CreateKanbanTaskInput): StoredKanbanTask {
        const createdAt = input.createdAt ?? Date.now()
        const status: KanbanTaskStatus = input.feedbackTokenHash ? 'awaiting_feedback' : 'published'
        this.db.query(
            `INSERT INTO kanban_tasks (
                artifact_id, namespace, source_session_id, source_type, source_machine_id, source_codex_session_id,
                source_directory_name, source_git_branch,
                status, feedback_request,
                feedback_token_hash, feedback_lease_id, feedback_lease_expires_at,
                feedback_filename, feedback_size, feedback_sha256, feedback_metadata,
                feedback_received_at, review_delivered_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
        ).run(
            input.artifactId,
            input.namespace,
            input.source?.type === 'hapi' ? input.source.sessionId : null,
            input.source?.type ?? null,
            input.source?.type === 'native-codex' ? input.source.machineId : null,
            input.source?.type === 'native-codex' ? input.source.codexSessionId : null,
            input.sourceContext?.directoryName ?? null,
            input.sourceContext?.gitBranch ?? null,
            status,
            input.feedbackRequest ?? null,
            input.feedbackTokenHash ?? null,
            createdAt,
            createdAt
        )
        const task = this.find(input.artifactId)
        if (!task) throw new Error('Could not create Kanban task')
        return task
    }

    find(artifactId: string): StoredKanbanTask | null {
        const found = this.db.query<KanbanTaskRow, [string]>('SELECT * FROM kanban_tasks WHERE artifact_id = ?').get(artifactId)
        return found ? row(found) : null
    }

    findMany(artifactIds: string[]): Map<string, StoredKanbanTask> {
        if (artifactIds.length === 0) return new Map()
        const placeholders = artifactIds.map(() => '?').join(', ')
        const rows = this.db.query<KanbanTaskRow, string[]>(
            `SELECT * FROM kanban_tasks WHERE artifact_id IN (${placeholders})`
        ).all(...artifactIds)
        return new Map(rows.map((entry) => {
            const task = row(entry)
            return [task.artifactId, task]
        }))
    }

    /** Claim the single-use feedback token for a brief upload window. */
    claimFeedbackUpload(input: {
        artifactId: string
        tokenHash: string
        leaseMs: number
        now?: number
    }): { leaseId: string; leaseExpiresAt: number } | null {
        const now = input.now ?? Date.now()
        const leaseId = randomUUID()
        const leaseExpiresAt = now + input.leaseMs
        const result = this.db.query(
            `UPDATE kanban_tasks
             SET feedback_lease_id = ?, feedback_lease_expires_at = ?, updated_at = ?
             WHERE artifact_id = ?
               AND status = 'awaiting_feedback'
               AND feedback_token_hash = ?
               AND (feedback_lease_expires_at IS NULL OR feedback_lease_expires_at < ?)
               AND EXISTS (
                   SELECT 1 FROM artifacts
                   WHERE artifacts.id = kanban_tasks.artifact_id
                     AND artifacts.revoked_at IS NULL
                     AND artifacts.expires_at > ?
               )`
        ).run(leaseId, leaseExpiresAt, now, input.artifactId, input.tokenHash, now, now)
        return result.changes === 1 ? { leaseId, leaseExpiresAt } : null
    }

    releaseFeedbackUpload(artifactId: string, leaseId: string, now = Date.now()): void {
        this.db.query(
            `UPDATE kanban_tasks
             SET feedback_lease_id = NULL, feedback_lease_expires_at = NULL, updated_at = ?
             WHERE artifact_id = ? AND status = 'awaiting_feedback' AND feedback_lease_id = ?`
        ).run(now, artifactId, leaseId)
    }

    completeFeedbackUpload(input: {
        artifactId: string
        leaseId: string
        filename: string
        size: number
        sha256: string
        metadata: FeedbackMetadata
        now?: number
    }): boolean {
        const now = input.now ?? Date.now()
        const result = this.db.query(
            `UPDATE kanban_tasks
             SET status = 'feedback_received',
                 feedback_lease_id = NULL,
                 feedback_lease_expires_at = NULL,
                 feedback_filename = ?,
                 feedback_size = ?,
                 feedback_sha256 = ?,
                 feedback_metadata = ?,
                 feedback_received_at = ?,
                 updated_at = ?
             WHERE artifact_id = ? AND status = 'awaiting_feedback' AND feedback_lease_id = ?`
        ).run(
            input.filename,
            input.size,
            input.sha256,
            JSON.stringify(input.metadata),
            now,
            now,
            input.artifactId,
            input.leaseId
        )
        return result.changes === 1
    }

    claimReviewDelivery(artifactId: string, now = Date.now()): boolean {
        const result = this.db.query(
            `UPDATE kanban_tasks
             SET status = 'review_sending', updated_at = ?
             WHERE artifact_id = ? AND status = 'feedback_received'`
        ).run(now, artifactId)
        return result.changes === 1
    }

    releaseReviewDelivery(artifactId: string, now = Date.now()): void {
        this.db.query(
            `UPDATE kanban_tasks
             SET status = 'feedback_received', updated_at = ?
             WHERE artifact_id = ? AND status = 'review_sending'`
        ).run(now, artifactId)
    }

    completeReviewDelivery(artifactId: string, now = Date.now()): boolean {
        const result = this.db.query(
            `UPDATE kanban_tasks
             SET status = 'review_sent', review_delivered_at = ?, updated_at = ?
             WHERE artifact_id = ? AND status = 'review_sending'`
        ).run(now, now, artifactId)
        return result.changes === 1
    }
}
