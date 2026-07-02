import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import { safeJsonParse } from './json'
import type {
    StoredRemoteServer,
    StoredRemoteServerCandidate,
    StoredRemoteServerCandidateStatus,
    StoredRemoteServerDetectedCommandKind
} from './types'

const DEFAULT_REMOTE_SERVER_WORKSPACE = '默认'

type RemoteServerRow = {
    id: string
    namespace: string
    name: string
    alias: string
    host: string
    user: string
    port: number
    workspace: string
    tags: string
    source_project: string
    source_project_path: string | null
    source_session_id: string
    source_session_title: string | null
    machine_id: string | null
    machine_ids: string | null
    last_verified_at: number | null
    last_used_at: number
    created_at: number
    updated_at: number
}

type RemoteServerCandidateRow = {
    id: string
    namespace: string
    machine_id: string
    session_id: string
    status: StoredRemoteServerCandidateStatus
    name: string
    alias: string
    host: string
    user: string
    port: number
    workspace: string
    tags: string
    source_project: string
    source_project_path: string | null
    source_session_title: string | null
    detected_command_kind: StoredRemoteServerDetectedCommandKind
    detected_tool_call_id: string | null
    existing_server_id: string | null
    verified_at: number
    last_seen_at: number
    created_at: number
    updated_at: number
}

export type RemoteServerCandidateInput = {
    namespace: string
    sessionId: string
    machineId?: string | null
    name?: string | null
    alias?: string | null
    host: string
    user: string
    port?: number | null
    workspace?: string | null
    tags?: string[] | null
    sourceProject: string
    sourceProjectPath?: string | null
    sourceSessionTitle?: string | null
    detectedCommandKind: StoredRemoteServerDetectedCommandKind
    detectedToolCallId?: string | null
}

export type UpdateRemoteServerInput = {
    name?: string
    alias?: string
    workspace?: string
    tags?: string[]
}

export type AcceptRemoteServerCandidateInput = {
    name?: string
    alias?: string
    workspace?: string
    tags?: string[]
}

export type VerifyRemoteServerCandidateResult =
    | { status: 'candidate-created'; candidate: StoredRemoteServerCandidate; created: boolean }
    | { status: 'already-recorded'; server: StoredRemoteServer }

export type AcceptRemoteServerCandidateResult =
    | { status: 'accepted'; server: StoredRemoteServer; candidate: StoredRemoteServerCandidate; created: boolean }
    | { status: 'not-found' }
    | { status: 'not-pending'; candidate: StoredRemoteServerCandidate }
    | { status: 'conflict'; server: StoredRemoteServer }

export function normalizeRemoteServerWorkspace(value: string | null | undefined): string {
    const workspace = value?.trim()
    return workspace && workspace.length > 0 ? workspace.slice(0, 80) : DEFAULT_REMOTE_SERVER_WORKSPACE
}

export function normalizeRemoteServerTags(value: string[] | null | undefined): string[] {
    const seen = new Set<string>()
    const result: string[] = []
    for (const raw of value ?? []) {
        const tag = raw.trim()
        if (!tag || seen.has(tag)) continue
        seen.add(tag)
        result.push(tag.slice(0, 50))
        if (result.length >= 12) break
    }
    return result
}

function normalizeName(value: string | null | undefined, host: string): string {
    const name = value?.trim()
    return name && name.length > 0 ? name.slice(0, 120) : host
}

function normalizeAlias(value: string | null | undefined): string {
    const alias = value?.trim()
    return alias && alias.length > 0 ? alias.slice(0, 120) : '未命名'
}

function normalizeHost(value: string): string {
    return value.trim().slice(0, 255)
}

function normalizeUser(value: string): string {
    return value.trim().slice(0, 120)
}

function normalizePort(value: number | null | undefined): number {
    if (Number.isInteger(value) && value !== null && value !== undefined && value >= 1 && value <= 65535) {
        return value
    }
    return 22
}

function normalizeMachineId(value: string | null | undefined): string {
    return value?.trim() ?? ''
}

function machineIdFromRow(value: string | null): string | null {
    return value && value.length > 0 ? value : null
}

function machineIdsFromRow(value: string | null): string[] {
    if (!value) return []
    return value.split('\u001f')
}

function parseTags(value: string | null): string[] {
    const parsed = safeJsonParse(value)
    if (!Array.isArray(parsed)) return []
    return normalizeRemoteServerTags(parsed.filter((item): item is string => typeof item === 'string'))
}

function serializeTags(value: string[] | null | undefined): string {
    return JSON.stringify(normalizeRemoteServerTags(value))
}

function toStoredRemoteServer(row: RemoteServerRow): StoredRemoteServer {
    return {
        id: row.id,
        namespace: row.namespace,
        name: row.name,
        alias: normalizeAlias(row.alias),
        host: row.host,
        user: row.user,
        port: row.port,
        workspace: row.workspace,
        tags: parseTags(row.tags),
        sourceProject: row.source_project,
        sourceProjectPath: row.source_project_path,
        sourceSessionId: row.source_session_id,
        sourceSessionTitle: row.source_session_title,
        machineId: machineIdFromRow(row.machine_id),
        machineIds: machineIdsFromRow(row.machine_ids),
        lastVerifiedAt: row.last_verified_at,
        lastUsedAt: row.last_used_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function toStoredRemoteServerCandidate(row: RemoteServerCandidateRow): StoredRemoteServerCandidate {
    return {
        id: row.id,
        namespace: row.namespace,
        machineId: machineIdFromRow(row.machine_id),
        sessionId: row.session_id,
        status: row.status,
        name: row.name,
        alias: normalizeAlias(row.alias),
        host: row.host,
        user: row.user,
        port: row.port,
        workspace: row.workspace,
        tags: parseTags(row.tags),
        sourceProject: row.source_project,
        sourceProjectPath: row.source_project_path,
        sourceSessionTitle: row.source_session_title,
        detectedCommandKind: row.detected_command_kind,
        detectedToolCallId: row.detected_tool_call_id,
        existingServerId: row.existing_server_id,
        verifiedAt: row.verified_at,
        lastSeenAt: row.last_seen_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

const REMOTE_SERVER_SELECT = `
    SELECT rs.*,
           (
               SELECT machine_id
               FROM remote_server_connections
               WHERE server_id = rs.id
               ORDER BY last_verified_at DESC
               LIMIT 1
           ) AS machine_id,
           (
               SELECT last_verified_at
               FROM remote_server_connections
               WHERE server_id = rs.id
               ORDER BY last_verified_at DESC
               LIMIT 1
           ) AS last_verified_at,
           (
               SELECT group_concat(machine_id, char(31))
               FROM remote_server_connections
               WHERE server_id = rs.id
           ) AS machine_ids
    FROM remote_servers rs
`

function getRemoteServerById(db: Database, id: string): StoredRemoteServer | null {
    const row = db.prepare(`${REMOTE_SERVER_SELECT} WHERE rs.id = ?`).get(id) as RemoteServerRow | undefined
    return row ? toStoredRemoteServer(row) : null
}

export function getRemoteServerByNamespace(db: Database, id: string, namespace: string): StoredRemoteServer | null {
    const row = db.prepare(`${REMOTE_SERVER_SELECT} WHERE rs.id = ? AND rs.namespace = ?`).get(id, namespace) as RemoteServerRow | undefined
    return row ? toStoredRemoteServer(row) : null
}

export function listRemoteServers(db: Database, namespace: string): StoredRemoteServer[] {
    const rows = db.prepare(`
        ${REMOTE_SERVER_SELECT}
        WHERE rs.namespace = ?
        ORDER BY rs.last_used_at DESC, rs.updated_at DESC, rs.name COLLATE NOCASE ASC
    `).all(namespace) as RemoteServerRow[]
    return rows.map(toStoredRemoteServer)
}

export function findRemoteServerByTarget(
    db: Database,
    namespace: string,
    workspace: string,
    user: string,
    host: string,
    port: number
): StoredRemoteServer | null {
    const row = db.prepare(`
        ${REMOTE_SERVER_SELECT}
        WHERE rs.namespace = ?
          AND rs.workspace = ?
          AND rs.user = ?
          AND rs.host = ?
          AND rs.port = ?
        LIMIT 1
    `).get(namespace, workspace, user, host, port) as RemoteServerRow | undefined
    return row ? toStoredRemoteServer(row) : null
}

function upsertConnection(db: Database, serverId: string, machineId: string | null | undefined, verifiedAt: number): void {
    const normalizedMachineId = normalizeMachineId(machineId)
    db.prepare(`
        INSERT INTO remote_server_connections (
            id, server_id, machine_id, last_verified_at, created_at, updated_at
        ) VALUES (
            @id, @server_id, @machine_id, @last_verified_at, @created_at, @updated_at
        )
        ON CONFLICT(server_id, machine_id) DO UPDATE SET
            last_verified_at = excluded.last_verified_at,
            updated_at = excluded.updated_at
    `).run({
        id: randomUUID(),
        server_id: serverId,
        machine_id: normalizedMachineId,
        last_verified_at: verifiedAt,
        created_at: verifiedAt,
        updated_at: verifiedAt
    })
}

function upsertCandidateConnection(db: Database, candidateId: string, machineId: string | null | undefined, verifiedAt: number): void {
    const normalizedMachineId = normalizeMachineId(machineId)
    db.prepare(`
        INSERT INTO remote_server_candidate_connections (
            id, candidate_id, machine_id, last_verified_at, created_at, updated_at
        ) VALUES (
            @id, @candidate_id, @machine_id, @last_verified_at, @created_at, @updated_at
        )
        ON CONFLICT(candidate_id, machine_id) DO UPDATE SET
            last_verified_at = excluded.last_verified_at,
            updated_at = excluded.updated_at
    `).run({
        id: randomUUID(),
        candidate_id: candidateId,
        machine_id: normalizedMachineId,
        last_verified_at: verifiedAt,
        created_at: verifiedAt,
        updated_at: verifiedAt
    })
}

function copyCandidateConnectionsToServer(
    db: Database,
    candidateId: string,
    serverId: string,
    fallbackMachineId: string | null | undefined,
    fallbackVerifiedAt: number
): void {
    const rows = db.prepare(`
        SELECT machine_id, last_verified_at
        FROM remote_server_candidate_connections
        WHERE candidate_id = ?
    `).all(candidateId) as Array<{ machine_id: string; last_verified_at: number }>

    if (rows.length === 0) {
        upsertConnection(db, serverId, fallbackMachineId, fallbackVerifiedAt)
        return
    }

    for (const row of rows) {
        upsertConnection(db, serverId, row.machine_id, row.last_verified_at)
    }
}

export function remoteServerHasConnection(
    db: Database,
    serverId: string,
    machineId: string | null | undefined
): boolean {
    const row = db.prepare(`
        SELECT 1
        FROM remote_server_connections
        WHERE server_id = ?
          AND machine_id = ?
        LIMIT 1
    `).get(serverId, normalizeMachineId(machineId)) as { 1: number } | undefined
    return Boolean(row)
}

export function touchRemoteServerLastUsed(
    db: Database,
    id: string,
    namespace: string,
    at: number,
    machineId?: string | null
): StoredRemoteServer | null {
    return db.transaction(() => touchRemoteServerLastUsedInTransaction(db, id, namespace, at, machineId))()
}

function touchRemoteServerLastUsedInTransaction(
    db: Database,
    id: string,
    namespace: string,
    at: number,
    machineId?: string | null
): StoredRemoteServer | null {
    const result = db.prepare(`
        UPDATE remote_servers
        SET last_used_at = CASE WHEN last_used_at > @last_used_at THEN last_used_at ELSE @last_used_at END,
            updated_at = CASE WHEN updated_at > @updated_at THEN updated_at ELSE @updated_at END
        WHERE id = @id
          AND namespace = @namespace
    `).run({
        id,
        namespace,
        last_used_at: at,
        updated_at: at
    })

    if (result.changes === 0) {
        return null
    }

    if (machineId !== undefined) {
        upsertConnection(db, id, machineId, at)
    }

    return getRemoteServerByNamespace(db, id, namespace)
}

function listPendingCandidateByTarget(
    db: Database,
    namespace: string,
    workspace: string,
    user: string,
    host: string,
    port: number
): StoredRemoteServerCandidate | null {
    const row = db.prepare(`
        SELECT *
        FROM remote_server_candidates
        WHERE namespace = ?
          AND workspace = ?
          AND user = ?
          AND host = ?
          AND port = ?
          AND status = 'pending'
        LIMIT 1
    `).get(namespace, workspace, user, host, port) as RemoteServerCandidateRow | undefined
    return row ? toStoredRemoteServerCandidate(row) : null
}

export function verifyRemoteServerCandidate(
    db: Database,
    input: RemoteServerCandidateInput,
    now: number = Date.now()
): VerifyRemoteServerCandidateResult {
    const host = normalizeHost(input.host)
    const user = normalizeUser(input.user)
    const port = normalizePort(input.port)
    const workspace = normalizeRemoteServerWorkspace(input.workspace)
    const tags = normalizeRemoteServerTags(input.tags)
    const name = normalizeName(input.name, host)
    const alias = normalizeAlias(input.alias)
    const machineId = normalizeMachineId(input.machineId)

    return db.transaction((): VerifyRemoteServerCandidateResult => {
        const existingServer = findRemoteServerByTarget(db, input.namespace, workspace, user, host, port)
        if (existingServer) {
            upsertConnection(db, existingServer.id, machineId, now)
            const touched = touchRemoteServerLastUsedInTransaction(db, existingServer.id, input.namespace, now)
            return { status: 'already-recorded', server: touched ?? existingServer }
        }

        const existingCandidate = listPendingCandidateByTarget(db, input.namespace, workspace, user, host, port)
        if (existingCandidate) {
            db.prepare(`
                UPDATE remote_server_candidates
                SET machine_id = @machine_id,
                    session_id = @session_id,
                    name = @name,
                    alias = @alias,
                    tags = @tags,
                    source_project = @source_project,
                    source_project_path = @source_project_path,
                    source_session_title = @source_session_title,
                    detected_command_kind = @detected_command_kind,
                    detected_tool_call_id = @detected_tool_call_id,
                    verified_at = @verified_at,
                    last_seen_at = @last_seen_at,
                    updated_at = @updated_at
                WHERE id = @id
            `).run({
                id: existingCandidate.id,
                machine_id: machineId,
                session_id: input.sessionId,
                name,
                alias,
                tags: serializeTags(tags),
                source_project: input.sourceProject,
                source_project_path: input.sourceProjectPath ?? null,
                source_session_title: input.sourceSessionTitle ?? null,
                detected_command_kind: input.detectedCommandKind,
                detected_tool_call_id: input.detectedToolCallId ?? null,
                verified_at: now,
                last_seen_at: now,
                updated_at: now
            })
            upsertCandidateConnection(db, existingCandidate.id, machineId, now)
            const candidate = getRemoteServerCandidateByNamespace(db, existingCandidate.id, input.namespace)
            if (!candidate) throw new Error('Remote server candidate disappeared after update')
            return { status: 'candidate-created', candidate, created: false }
        }

        const id = randomUUID()
        db.prepare(`
            INSERT INTO remote_server_candidates (
                id, namespace, machine_id, session_id, status,
                name, alias, host, user, port, workspace, tags,
                source_project, source_project_path, source_session_title,
                detected_command_kind, detected_tool_call_id, existing_server_id,
                verified_at, last_seen_at, created_at, updated_at
            ) VALUES (
                @id, @namespace, @machine_id, @session_id, 'pending',
                @name, @alias, @host, @user, @port, @workspace, @tags,
                @source_project, @source_project_path, @source_session_title,
                @detected_command_kind, @detected_tool_call_id, NULL,
                @verified_at, @last_seen_at, @created_at, @updated_at
            )
        `).run({
            id,
            namespace: input.namespace,
            machine_id: machineId,
            session_id: input.sessionId,
            name,
            alias,
            host,
            user,
            port,
            workspace,
            tags: serializeTags(tags),
            source_project: input.sourceProject,
            source_project_path: input.sourceProjectPath ?? null,
            source_session_title: input.sourceSessionTitle ?? null,
            detected_command_kind: input.detectedCommandKind,
            detected_tool_call_id: input.detectedToolCallId ?? null,
            verified_at: now,
            last_seen_at: now,
            created_at: now,
            updated_at: now
        })
        upsertCandidateConnection(db, id, machineId, now)

        const candidate = getRemoteServerCandidateByNamespace(db, id, input.namespace)
        if (!candidate) throw new Error('Failed to create remote server candidate')
        return { status: 'candidate-created', candidate, created: true }
    })()
}

export function getRemoteServerCandidateByNamespace(
    db: Database,
    id: string,
    namespace: string
): StoredRemoteServerCandidate | null {
    const row = db.prepare(`
        SELECT *
        FROM remote_server_candidates
        WHERE id = ?
          AND namespace = ?
    `).get(id, namespace) as RemoteServerCandidateRow | undefined
    return row ? toStoredRemoteServerCandidate(row) : null
}

export function listRemoteServerCandidates(
    db: Database,
    namespace: string,
    status?: StoredRemoteServerCandidateStatus
): StoredRemoteServerCandidate[] {
    const rows = status
        ? db.prepare(`
            SELECT *
            FROM remote_server_candidates
            WHERE namespace = ?
              AND status = ?
            ORDER BY updated_at DESC
        `).all(namespace, status) as RemoteServerCandidateRow[]
        : db.prepare(`
            SELECT *
            FROM remote_server_candidates
            WHERE namespace = ?
            ORDER BY updated_at DESC
        `).all(namespace) as RemoteServerCandidateRow[]

    return rows.map(toStoredRemoteServerCandidate)
}

export function acceptRemoteServerCandidate(
    db: Database,
    id: string,
    namespace: string,
    input: AcceptRemoteServerCandidateInput,
    now: number = Date.now()
): AcceptRemoteServerCandidateResult {
    return db.transaction((): AcceptRemoteServerCandidateResult => {
        const candidate = getRemoteServerCandidateByNamespace(db, id, namespace)
        if (!candidate) {
            return { status: 'not-found' }
        }
        if (candidate.status !== 'pending') {
            return { status: 'not-pending', candidate }
        }

        const name = normalizeName(input.name ?? candidate.name, candidate.host)
        const alias = normalizeAlias(input.alias ?? candidate.alias)
        const workspace = normalizeRemoteServerWorkspace(input.workspace ?? candidate.workspace)
        const tags = input.tags === undefined ? candidate.tags : normalizeRemoteServerTags(input.tags)

        const existing = findRemoteServerByTarget(db, namespace, workspace, candidate.user, candidate.host, candidate.port)
        if (existing) {
            copyCandidateConnectionsToServer(db, candidate.id, existing.id, candidate.machineId, candidate.verifiedAt)
            db.prepare(`
                UPDATE remote_server_candidates
                SET status = 'accepted',
                    name = @name,
                    alias = @alias,
                    workspace = @workspace,
                    tags = @tags,
                    existing_server_id = @existing_server_id,
                    updated_at = @updated_at
                WHERE id = @id
                  AND namespace = @namespace
            `).run({
                id,
                namespace,
                name,
                alias,
                workspace,
                tags: serializeTags(tags),
                existing_server_id: existing.id,
                updated_at: now
            })
            const updatedCandidate = getRemoteServerCandidateByNamespace(db, id, namespace)
            if (!updatedCandidate) throw new Error('Remote server candidate disappeared after accept')
            const touched = touchRemoteServerLastUsedInTransaction(db, existing.id, namespace, now)
            return { status: 'accepted', server: touched ?? existing, candidate: updatedCandidate, created: false }
        }

        const serverId = randomUUID()
        db.prepare(`
            INSERT INTO remote_servers (
                id, namespace, name, alias, host, user, port, workspace, tags,
                source_project, source_project_path, source_session_id, source_session_title,
                last_used_at, created_at, updated_at
            ) VALUES (
                @id, @namespace, @name, @alias, @host, @user, @port, @workspace, @tags,
                @source_project, @source_project_path, @source_session_id, @source_session_title,
                @last_used_at, @created_at, @updated_at
            )
        `).run({
            id: serverId,
            namespace,
            name,
            alias,
            host: candidate.host,
            user: candidate.user,
            port: candidate.port,
            workspace,
            tags: serializeTags(tags),
            source_project: candidate.sourceProject,
            source_project_path: candidate.sourceProjectPath,
            source_session_id: candidate.sessionId,
            source_session_title: candidate.sourceSessionTitle,
            last_used_at: now,
            created_at: now,
            updated_at: now
        })
        copyCandidateConnectionsToServer(db, candidate.id, serverId, candidate.machineId, candidate.verifiedAt)
        db.prepare(`
            UPDATE remote_server_candidates
            SET status = 'accepted',
                name = @name,
                alias = @alias,
                workspace = @workspace,
                tags = @tags,
                existing_server_id = @existing_server_id,
                updated_at = @updated_at
            WHERE id = @id
              AND namespace = @namespace
        `).run({
            id,
            namespace,
            name,
            alias,
            workspace,
            tags: serializeTags(tags),
            existing_server_id: serverId,
            updated_at: now
        })

        const server = getRemoteServerByNamespace(db, serverId, namespace)
        const updatedCandidate = getRemoteServerCandidateByNamespace(db, id, namespace)
        if (!server || !updatedCandidate) throw new Error('Failed to accept remote server candidate')
        return { status: 'accepted', server, candidate: updatedCandidate, created: true }
    })()
}

export function dismissRemoteServerCandidate(
    db: Database,
    id: string,
    namespace: string,
    now: number = Date.now()
): StoredRemoteServerCandidate | null {
    return db.transaction(() => {
        const result = db.prepare(`
            UPDATE remote_server_candidates
            SET status = 'dismissed',
                updated_at = @updated_at
            WHERE id = @id
              AND namespace = @namespace
              AND status = 'pending'
        `).run({
            id,
            namespace,
            updated_at: now
        })
        if (result.changes === 0) {
            return getRemoteServerCandidateByNamespace(db, id, namespace)
        }
        return getRemoteServerCandidateByNamespace(db, id, namespace)
    })()
}

export function updateRemoteServer(
    db: Database,
    id: string,
    namespace: string,
    input: UpdateRemoteServerInput,
    now: number = Date.now()
): StoredRemoteServer | null {
    const current = getRemoteServerByNamespace(db, id, namespace)
    if (!current) return null

    const name = input.name !== undefined ? normalizeName(input.name, current.host) : current.name
    const alias = input.alias !== undefined ? normalizeAlias(input.alias) : current.alias
    const workspace = input.workspace !== undefined ? normalizeRemoteServerWorkspace(input.workspace) : current.workspace
    const tags = input.tags !== undefined ? normalizeRemoteServerTags(input.tags) : current.tags

    db.prepare(`
        UPDATE remote_servers
        SET name = @name,
            alias = @alias,
            workspace = @workspace,
            tags = @tags,
            updated_at = @updated_at
        WHERE id = @id
          AND namespace = @namespace
    `).run({
        id,
        namespace,
        name,
        alias,
        workspace,
        tags: serializeTags(tags),
        updated_at: now
    })

    return getRemoteServerByNamespace(db, id, namespace)
}

export function deleteRemoteServer(db: Database, id: string, namespace: string): boolean {
    return db.transaction(() => {
        db.prepare(`
            UPDATE sessions
            SET remote_server_id = NULL,
                seq = seq + 1
            WHERE namespace = ?
              AND remote_server_id = ?
        `).run(namespace, id)
        const result = db.prepare(`
            DELETE FROM remote_servers
            WHERE id = ?
              AND namespace = ?
        `).run(id, namespace)
        return result.changes > 0
    })()
}

export function toRemoteServerSnapshot(server: StoredRemoteServer): {
    id: string
    name: string
    alias: string
    host: string
    user: string
    port: number
    workspace: string
    tags: string[]
    sourceProject: string
} {
    return {
        id: server.id,
        name: server.name,
        alias: server.alias,
        host: server.host,
        user: server.user,
        port: server.port,
        workspace: server.workspace,
        tags: server.tags,
        sourceProject: server.sourceProject
    }
}
