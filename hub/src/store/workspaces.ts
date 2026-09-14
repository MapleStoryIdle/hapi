import type { Database } from 'bun:sqlite'
import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { constantTimeEquals } from '../utils/crypto'
import { parseAccessToken } from '../utils/accessToken'

export type WorkspaceAccessKind = 'legacy' | 'web' | 'runner'
export type RunnerPairingState =
    'pending' | 'approved' | 'denied' | 'expired' | 'consumed'

export const RUNNER_PAIRING_POLL_INTERVAL_MS = 5_000

export type Workspace = {
    id: string
    name: string
    dataNamespace: string
    createdAt: number
}

export type WorkspaceAccess = {
    workspace: Workspace
    accessKeyId: string
    kind: WorkspaceAccessKind
    boundMachineId: string | null
}

export type WorkspaceAccessKey = {
    id: string
    kind: WorkspaceAccessKind
    name: string
    createdAt: number
    expiresAt: number | null
    lastUsedAt: number | null
    boundMachineId: string | null
    publicJwk: string | null
    publicKeyThumbprint: string | null
}

export type RunnerKeyBinding = {
    workspaceId: string
    accessKeyId: string
    boundMachineId: string
    publicJwk: string
    publicKeyThumbprint: string
}

export type WebSession = {
    id: string
    workspace: Workspace
    accessKeyId: string
    createdAt: number
    lastUsedAt: number
    idleExpiresAt: number
    absoluteExpiresAt: number
}

export type IssuedWebSession = WebSession & {
    token: string
    csrfToken: string
}

export type RunnerPairing = {
    id: string
    workspaceId: string | null
    accessKeyId: string | null
    state: RunnerPairingState
    humanCode: string
    runnerName: string
    runnerMachineId: string
    publicJwk: string
    publicKeyThumbprint: string
    pollIntervalMs: number
    lastPollAt: number | null
    nextPollAt: number
    pollViolations: number
    createdAt: number
    expiresAt: number
    approvedAt: number | null
    deniedAt: number | null
    consumedAt: number | null
}

export type IssuedRunnerPairing = RunnerPairing & { deviceCode: string }

export type RunnerPairingPollResult = {
    status: RunnerPairingState | 'slow_down'
    accessKeyId?: string
    retryAfterMs?: number
}

export type RegisterClientGeneratedKeyInput = {
    kind: Exclude<WorkspaceAccessKind, 'legacy'>
    name: string
    token: string
    expiresAt?: number | null
    boundMachineId?: string | null
    publicJwk?: string | null
    publicKeyThumbprint?: string | null
}

export type IssueRunnerPairingInput = {
    runnerName: string
    runnerMachineId: string
    runnerToken: string
    publicJwk: string
    publicKeyThumbprint: string
    expiresAt: number
}

/** Test-only deterministic secret injection; production callers must not use it. */
export type RunnerPairingTestOptions = {
    deviceCode?: string
    humanCode?: string
}

export const WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data_namespace TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    legacy_eligible INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workspace_access_keys (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('legacy', 'web', 'runner')),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER,
    bound_machine_id TEXT,
    public_jwk TEXT,
    public_key_thumbprint TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_access_keys_workspace ON workspace_access_keys(workspace_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_workspace_access_keys_runner_machine ON workspace_access_keys(workspace_id, bound_machine_id) WHERE bound_machine_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS web_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    access_key_id TEXT NOT NULL REFERENCES workspace_access_keys(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    idle_expires_at INTEGER NOT NULL,
    absolute_expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_access_key ON web_sessions(access_key_id, revoked_at);
CREATE TABLE IF NOT EXISTS runner_pairings (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
    access_key_id TEXT REFERENCES workspace_access_keys(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'denied', 'expired', 'consumed')),
    device_code_hash TEXT NOT NULL UNIQUE,
    human_code TEXT NOT NULL UNIQUE,
    runner_name TEXT NOT NULL,
    runner_machine_id TEXT NOT NULL,
    runner_token_hash TEXT NOT NULL,
    public_jwk TEXT NOT NULL,
    public_key_thumbprint TEXT NOT NULL,
    poll_interval_ms INTEGER NOT NULL,
    last_poll_at INTEGER,
    next_poll_at INTEGER NOT NULL,
    poll_violations INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_at INTEGER,
    denied_at INTEGER,
    consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runner_pairings_workspace_state ON runner_pairings(workspace_id, state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_pairings_active_token ON runner_pairings(runner_token_hash) WHERE state IN ('pending', 'approved');
`

type WorkspaceRow = {
    id: string
    name: string
    data_namespace: string
    created_at: number
}
type AccessRow = WorkspaceRow & {
    access_key_id: string
    kind: WorkspaceAccessKind
    expires_at: number | null
    revoked_at: number | null
    bound_machine_id: string | null
}
type WebSessionRow = WorkspaceRow & {
    session_id: string
    access_key_id: string
    session_created_at: number
    session_last_used_at: number
    idle_expires_at: number
    absolute_expires_at: number
    session_revoked_at: number | null
    key_kind: WorkspaceAccessKind
    key_expires_at: number | null
    key_revoked_at: number | null
}
type PairingRow = {
    id: string
    workspace_id: string | null
    access_key_id: string | null
    state: RunnerPairingState
    human_code: string
    runner_name: string
    runner_machine_id: string
    public_jwk: string
    public_key_thumbprint: string
    poll_interval_ms: number
    last_poll_at: number | null
    next_poll_at: number
    poll_violations: number
    created_at: number
    expires_at: number
    approved_at: number | null
    denied_at: number | null
    consumed_at: number | null
}
type PairingSecretRow = PairingRow & {
    runner_token_hash: string
    device_code_hash: string
}

function tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function fromRow(row: WorkspaceRow): Workspace {
    return {
        id: row.id,
        name: row.name,
        dataNamespace: row.data_namespace,
        createdAt: row.created_at,
    }
}

function pairingFromRow(row: PairingRow): RunnerPairing {
    return {
        id: row.id,
        workspaceId: row.workspace_id,
        accessKeyId: row.access_key_id,
        state: row.state,
        humanCode: row.human_code,
        runnerName: row.runner_name,
        runnerMachineId: row.runner_machine_id,
        publicJwk: row.public_jwk,
        publicKeyThumbprint: row.public_key_thumbprint,
        pollIntervalMs: row.poll_interval_ms,
        lastPollAt: row.last_poll_at,
        nextPollAt: row.next_poll_at,
        pollViolations: row.poll_violations,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        deniedAt: row.denied_at,
        consumedAt: row.consumed_at,
    }
}

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const HUMAN_CODE_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/
const WEB_TOKEN_PATTERN = /^spw[A-Za-z0-9_-]{43}$/
const RUNNER_TOKEN_PATTERN = /^spr[A-Za-z0-9_-]{43}$/

function generateHumanCode(): string {
    const bytes = randomBytes(8)
    let value = ''
    for (let i = 0; i < 8; i++) value += CROCKFORD_BASE32[bytes[i] & 31]
    return value
}

function isCanonicalToken(token: string, prefix: 'spw' | 'spr' | ''): boolean {
    const opaque = prefix ? token.slice(prefix.length) : token
    const pattern = prefix === 'spw' ? WEB_TOKEN_PATTERN : prefix === 'spr' ? RUNNER_TOKEN_PATTERN : /^[A-Za-z0-9_-]{43}$/
    return pattern.test(token) && Buffer.from(opaque, 'base64url').length === 32 && Buffer.from(opaque, 'base64url').toString('base64url') === opaque
}

type PublicEcJwk = {
    kty?: string
    crv?: string
    x?: string
    y?: string
    d?: string
}

function validatePublicJwk(value: string): { canonical: string; thumbprint: string } | null {
    try {
        const parsed = JSON.parse(value) as PublicEcJwk
        if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || typeof parsed.x !== 'string' || typeof parsed.y !== 'string' || parsed.d !== undefined) return null
        const exported = createPublicKey({ key: parsed, format: 'jwk' }).export({ format: 'jwk' })
        if (exported.kty !== 'EC' || exported.crv !== 'P-256' || typeof exported.x !== 'string' || typeof exported.y !== 'string') return null
        const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: exported.x, y: exported.y })
        return { canonical, thumbprint: createHash('sha256').update(canonical).digest('base64url') }
    } catch {
        return null
    }
}

function isThumbprint(value: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(value)
}

export class WorkspaceStore {
    private accessKeyRevokedHandler: ((accessKeyId: string) => void) | null = null

    constructor(private readonly db: Database) {}

    setAccessKeyRevokedHandler(handler: ((accessKeyId: string) => void) | null): void {
        this.accessKeyRevokedHandler = handler
    }

    get(id: string): Workspace | null {
        const row = this.db
            .query(
                'SELECT id,name,data_namespace,created_at FROM workspaces WHERE id=?',
            )
            .get(id) as WorkspaceRow | null
        return row ? fromRow(row) : null
    }

    getByDataNamespace(namespace: string): Workspace | null {
        const row = this.db
            .query(
                'SELECT id,name,data_namespace,created_at FROM workspaces WHERE data_namespace=?',
            )
            .get(namespace) as WorkspaceRow | null
        return row ? fromRow(row) : null
    }

    ensureLegacyWorkspace(
        namespace: string,
        legacyEligible: boolean = false,
    ): Workspace {
        const existing = this.getByDataNamespace(namespace)
        if (existing) return existing
        const workspace: Workspace = {
            id: randomUUID(),
            name: namespace === 'default' ? 'Personal' : namespace,
            dataNamespace: namespace,
            createdAt: Date.now(),
        }
        this.db
            .query(
                'INSERT INTO workspaces(id,name,data_namespace,created_at,legacy_eligible) VALUES(?,?,?,?,?)',
            )
            .run(
                workspace.id,
                workspace.name,
                workspace.dataNamespace,
                workspace.createdAt,
                legacyEligible ? 1 : 0,
            )
        return workspace
    }

    bootstrapExistingNamespaces(legacyEligible: boolean = false): void {
        const candidates = [
            'sessions',
            'machines',
            'users',
            'push_subscriptions',
            'artifacts',
            'kanban_tasks',
            'session_groups',
            'session_labels',
            'session_pins',
            'kanban_order',
            'monitors',
            'bark_settings',
            'plugin_settings',
        ] as const
        const existingTables = new Set(
            (
                this.db
                    .query("SELECT name FROM sqlite_master WHERE type='table'")
                    .all() as Array<{ name: string }>
            ).map((row) => row.name),
        )
        const namespaceQueries = candidates
            .filter((table) => existingTables.has(table))
            .map((table) => `SELECT namespace FROM ${table}`)
        const namespaces =
            namespaceQueries.length > 0
                ? (this.db
                      .query(namespaceQueries.join(' UNION '))
                      .all() as Array<{
                      namespace: string
                  }>)
                : []
        this.ensureLegacyWorkspace('default', legacyEligible)
        for (const row of namespaces)
            this.ensureLegacyWorkspace(row.namespace, legacyEligible)
    }

    bootstrapLegacyCredentials(baseToken: string): void {
        const workspaces = this.db
            .query(
                'SELECT id,name,data_namespace,created_at FROM workspaces WHERE legacy_eligible=1',
            )
            .all() as WorkspaceRow[]
        const now = Date.now()
        const insert = this.db
            .query(`INSERT OR IGNORE INTO workspace_access_keys
            (id,workspace_id,kind,name,token_hash,created_at) VALUES(?,?,?,?,?,?)`)
        this.db.transaction(() => {
            for (const workspace of workspaces) {
                const token =
                    workspace.data_namespace === 'default'
                        ? baseToken
                        : `${baseToken}:${workspace.data_namespace}`
                insert.run(
                    randomUUID(),
                    workspace.id,
                    'legacy',
                    'Migrated CLI_API_TOKEN',
                    tokenHash(token),
                    now,
                )
            }
        })()
    }

    authenticate(
        token: string,
        legacyBaseToken: string,
        purpose: 'web' | 'runner',
        machineId?: string,
    ): WorkspaceAccess | null {
        const now = Date.now()
        const row = this.db
            .query(
                `SELECT k.id access_key_id,k.kind,k.expires_at,k.revoked_at,k.bound_machine_id,w.id,w.name,w.data_namespace,w.created_at
            FROM workspace_access_keys k JOIN workspaces w ON w.id=k.workspace_id
            WHERE k.token_hash=?`,
            )
            .get(tokenHash(token)) as AccessRow | null
        if (row) {
            if (
                row.revoked_at !== null ||
                (row.expires_at !== null && row.expires_at <= now) ||
                (row.kind !== 'legacy' && row.kind !== purpose) ||
                (purpose === 'runner' && row.kind === 'runner' &&
                    (row.bound_machine_id === null || row.bound_machine_id !== machineId))
            )
                return null
            this.db
                .query(
                    'UPDATE workspace_access_keys SET last_used_at=? WHERE id=?',
                )
                .run(now, row.access_key_id)
            return {
                workspace: fromRow(row),
                accessKeyId: row.access_key_id,
                kind: row.kind,
                boundMachineId: row.bound_machine_id,
            }
        }

        const legacy = parseAccessToken(token)
        if (!legacy || !constantTimeEquals(legacy.baseToken, legacyBaseToken))
            return null
        const canonicalLegacyToken =
            legacy.namespace === 'default'
                ? legacyBaseToken
                : `${legacyBaseToken}:${legacy.namespace}`
        if (!constantTimeEquals(token, canonicalLegacyToken)) return null
        const eligible = this.db
            .query(
                'SELECT id,name,data_namespace,created_at FROM workspaces WHERE data_namespace=? AND legacy_eligible=1',
            )
            .get(legacy.namespace) as WorkspaceRow | null
        if (!eligible) return null
        const workspace = fromRow(eligible)
        const accessKeyId = randomUUID()
        this.db
            .query(
                `INSERT INTO workspace_access_keys(id,workspace_id,kind,name,token_hash,created_at,last_used_at)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(token_hash) DO UPDATE SET last_used_at=excluded.last_used_at`,
            )
            .run(
                accessKeyId,
                workspace.id,
                'legacy',
                'Migrated CLI_API_TOKEN',
                tokenHash(token),
                now,
                now,
            )
        const stored = this.db
            .query('SELECT id FROM workspace_access_keys WHERE token_hash=?')
            .get(tokenHash(token)) as { id: string }
        return { workspace, accessKeyId: stored.id, kind: 'legacy', boundMachineId: null }
    }

    create(name: string): Workspace {
        return this.db.transaction(() => {
            const workspace: Workspace = {
                id: randomUUID(),
                name,
                dataNamespace: randomUUID(),
                createdAt: Date.now(),
            }
            this.db
                .query(
                    'INSERT INTO workspaces(id,name,data_namespace,created_at,legacy_eligible) VALUES(?,?,?,?,0)',
                )
                .run(
                    workspace.id,
                    workspace.name,
                    workspace.dataNamespace,
                    workspace.createdAt,
                )
            return workspace
        })()
    }

    createWithWebKey(
        name: string,
        token: string,
        keyName: string = 'Owner',
    ): { workspace: Workspace; accessKeyId: string } {
        if (!isCanonicalToken(token, 'spw'))
            throw new Error('Web access key token has an invalid format')
        return this.db.transaction(() => {
            const workspace: Workspace = {
                id: randomUUID(),
                name,
                dataNamespace: randomUUID(),
                createdAt: Date.now(),
            }
            const accessKeyId = randomUUID()
            this.db
                .query(
                    'INSERT INTO workspaces(id,name,data_namespace,created_at,legacy_eligible) VALUES(?,?,?,?,0)',
                )
                .run(
                    workspace.id,
                    workspace.name,
                    workspace.dataNamespace,
                    workspace.createdAt,
                )
            this.db
                .query(
                    `INSERT INTO workspace_access_keys
                    (id,workspace_id,kind,name,token_hash,created_at)
                    VALUES(?,?,'web',?,?,?)`,
                )
                .run(
                    accessKeyId,
                    workspace.id,
                    keyName,
                    tokenHash(token),
                    workspace.createdAt,
                )
            return { workspace, accessKeyId }
        })()
    }

    count(): number {
        return (
            this.db.query('SELECT COUNT(*) count FROM workspaces').get() as {
                count: number
            }
        ).count
    }

    issueKey(
        workspaceId: string,
        kind: Exclude<WorkspaceAccessKind, 'legacy'>,
        name: string,
        expiresAt?: number | null,
    ): { id: string; token: string } {
        if (kind === 'runner')
            throw new Error(
                'Runner keys require machine binding and a public key',
            )
        const token = `spw${randomBytes(32).toString('base64url')}`
        const { id } = this.registerClientGeneratedKey(workspaceId, {
            kind,
            name,
            token,
            expiresAt,
        })
        return { id, token }
    }

    registerClientGeneratedKey(
        workspaceId: string,
        input: RegisterClientGeneratedKeyInput,
    ): { id: string } {
        let runnerPublicKey: { canonical: string; thumbprint: string } | null = null
        if (input.kind === 'web') {
            if (!isCanonicalToken(input.token, 'spw'))
                throw new Error('Web access key token has an invalid format')
            if (
                input.boundMachineId ||
                input.publicJwk ||
                input.publicKeyThumbprint
            )
                throw new Error(
                    'Web access keys cannot carry runner binding metadata',
                )
        } else {
            if (!isCanonicalToken(input.token, 'spr'))
                throw new Error('Runner access key token has an invalid format')
            if (
                !input.boundMachineId ||
                !input.publicJwk ||
                !input.publicKeyThumbprint
            )
                throw new Error(
                    'Runner keys require machine binding and public-key metadata',
                )
            runnerPublicKey = validatePublicJwk(input.publicJwk)
            if (!runnerPublicKey || !isThumbprint(input.publicKeyThumbprint) || !constantTimeEquals(runnerPublicKey.thumbprint, input.publicKeyThumbprint))
                throw new Error('Runner public-key metadata is invalid')
        }
        return this.db.transaction(() => {
            this.assertWorkspace(workspaceId)
            this.assertAccessKeyCapacity(workspaceId)
            const id = randomUUID()
            this.db
                .query(
                    `INSERT INTO workspace_access_keys
                (id,workspace_id,kind,name,token_hash,created_at,expires_at,bound_machine_id,public_jwk,public_key_thumbprint)
                VALUES(?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                    id,
                    workspaceId,
                    input.kind,
                    input.name,
                    tokenHash(input.token),
                    Date.now(),
                    input.expiresAt ?? null,
                    input.kind === 'runner'
                        ? (input.boundMachineId ?? null)
                        : null,
                    input.kind === 'runner' ? runnerPublicKey!.canonical : null,
                    input.kind === 'runner' ? runnerPublicKey!.thumbprint : null,
                )
            return { id }
        })()
    }

    bindRunnerKey(
        workspaceId: string,
        keyId: string,
        machineId: string,
        publicJwk: string,
        publicKeyThumbprint: string,
    ): boolean {
        const validated = validatePublicJwk(publicJwk)
        if (!machineId || !validated || !isThumbprint(publicKeyThumbprint) || !constantTimeEquals(validated.thumbprint, publicKeyThumbprint))
            return false
        return Boolean(
            this.db
                .query(
                    `SELECT 1 FROM workspace_access_keys
            WHERE id=? AND workspace_id=? AND kind='runner' AND revoked_at IS NULL
                AND bound_machine_id=? AND public_jwk=? AND public_key_thumbprint=?`,
                )
                .get(
                    keyId,
                    workspaceId,
                    machineId,
                    validated.canonical,
                    validated.thumbprint,
                ),
        )
    }

    listKeys(workspaceId: string): WorkspaceAccessKey[] {
        const rows = this.db
            .query(
                `SELECT id,kind,name,created_at,expires_at,last_used_at,bound_machine_id,public_jwk,public_key_thumbprint
            FROM workspace_access_keys WHERE workspace_id=? AND revoked_at IS NULL ORDER BY created_at`,
            )
            .all(workspaceId) as Array<{
            id: string
            kind: WorkspaceAccessKind
            name: string
            created_at: number
            expires_at: number | null
            last_used_at: number | null
            bound_machine_id: string | null
            public_jwk: string | null
            public_key_thumbprint: string | null
        }>
        return rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            name: row.name,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
            lastUsedAt: row.last_used_at,
            boundMachineId: row.bound_machine_id,
            publicJwk: row.public_jwk,
            publicKeyThumbprint: row.public_key_thumbprint,
        }))
    }

    isKeyActive(
        workspaceId: string,
        keyId: string,
        purpose: 'web' | 'runner',
    ): boolean {
        const row = this.db
            .query(
                `SELECT kind FROM workspace_access_keys
            WHERE id=? AND workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
            )
            .get(keyId, workspaceId, Date.now()) as {
            kind: WorkspaceAccessKind
        } | null
        return Boolean(row && (row.kind === 'legacy' || row.kind === purpose))
    }

    getActiveRunnerKeyBinding(
        workspaceId: string,
        accessKeyId: string,
        now: number = Date.now(),
    ): RunnerKeyBinding | null {
        const row = this.db
            .query(
                `SELECT workspace_id, id access_key_id, bound_machine_id, public_jwk, public_key_thumbprint
                FROM workspace_access_keys
                WHERE workspace_id=? AND id=? AND kind='runner' AND revoked_at IS NULL
                    AND (expires_at IS NULL OR expires_at>?)
                    AND bound_machine_id IS NOT NULL AND public_jwk IS NOT NULL
                    AND public_key_thumbprint IS NOT NULL`,
            )
            .get(workspaceId, accessKeyId, now) as {
            workspace_id: string
            access_key_id: string
            bound_machine_id: string
            public_jwk: string
            public_key_thumbprint: string
        } | null
        return row ? {
            workspaceId: row.workspace_id,
            accessKeyId: row.access_key_id,
            boundMachineId: row.bound_machine_id,
            publicJwk: row.public_jwk,
            publicKeyThumbprint: row.public_key_thumbprint,
        } : null
    }

    revokeKey(workspaceId: string, keyId: string): boolean {
        const changed = this.db.transaction(() => {
            const changed =
                this.db
                    .query(
                        'UPDATE workspace_access_keys SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL',
                    )
                    .run(Date.now(), keyId, workspaceId).changes > 0
            if (changed) this.revokeWebSessionsByAccessKey(keyId)
            return changed
        })()
        if (changed) this.accessKeyRevokedHandler?.(keyId)
        return changed
    }

    issueWebSession(
        workspaceId: string,
        accessKeyId: string,
        idleTtlMs: number,
        absoluteTtlMs: number,
        now: number = Date.now(),
    ): IssuedWebSession {
        if (idleTtlMs <= 0 || absoluteTtlMs <= 0)
            throw new Error('Web session expiry must be positive')
        return this.db.transaction(() => {
            const key = this.db
                .query(
                    `SELECT kind FROM workspace_access_keys WHERE id=? AND workspace_id=?
                AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
                )
                .get(accessKeyId, workspaceId, now) as {
                kind: WorkspaceAccessKind
            } | null
            if (!key || (key.kind !== 'legacy' && key.kind !== 'web'))
                throw new Error('Active web access key required')
            const workspace = this.get(workspaceId)
            if (!workspace) throw new Error('Workspace not found')
            const id = randomUUID()
            const token = randomBytes(32).toString('base64url')
            const csrfToken = randomBytes(32).toString('base64url')
            const absoluteExpiresAt = now + absoluteTtlMs
            const idleExpiresAt = Math.min(now + idleTtlMs, absoluteExpiresAt)
            this.db
                .query(
                    `INSERT INTO web_sessions
                (id,workspace_id,access_key_id,token_hash,csrf_hash,created_at,last_used_at,idle_expires_at,absolute_expires_at)
                VALUES(?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                    id,
                    workspaceId,
                    accessKeyId,
                    tokenHash(token),
                    tokenHash(csrfToken),
                    now,
                    now,
                    idleExpiresAt,
                    absoluteExpiresAt,
                )
            return {
                id,
                workspace,
                accessKeyId,
                createdAt: now,
                lastUsedAt: now,
                idleExpiresAt,
                absoluteExpiresAt,
                token,
                csrfToken,
            }
        })()
    }

    authenticateWebSession(
        token: string,
        idleTtlMs: number,
        now: number = Date.now(),
    ): WebSession | null {
        if (idleTtlMs <= 0)
            throw new Error('Web session idle expiry must be positive')
        return this.db.transaction(() => {
            const row = this.db
                .query(
                    `SELECT s.id session_id,s.access_key_id,s.created_at session_created_at,s.last_used_at session_last_used_at,
                s.idle_expires_at,s.absolute_expires_at,s.revoked_at session_revoked_at,k.kind key_kind,k.expires_at key_expires_at,k.revoked_at key_revoked_at,
                w.id,w.name,w.data_namespace,w.created_at
                FROM web_sessions s JOIN workspace_access_keys k ON k.id=s.access_key_id JOIN workspaces w ON w.id=s.workspace_id
                WHERE s.token_hash=?`,
                )
                .get(tokenHash(token)) as WebSessionRow | null
            if (
                !row ||
                row.session_revoked_at !== null ||
                row.idle_expires_at <= now ||
                row.absolute_expires_at <= now ||
                row.key_revoked_at !== null ||
                (row.key_expires_at !== null && row.key_expires_at <= now) ||
                (row.key_kind !== 'legacy' && row.key_kind !== 'web')
            )
                return null
            const idleExpiresAt = Math.min(
                now + idleTtlMs,
                row.absolute_expires_at,
            )
            if (
                this.db
                    .query(
                        'UPDATE web_sessions SET last_used_at=?,idle_expires_at=? WHERE id=? AND revoked_at IS NULL',
                    )
                    .run(now, idleExpiresAt, row.session_id).changes === 0
            )
                return null
            return {
                id: row.session_id,
                workspace: fromRow(row),
                accessKeyId: row.access_key_id,
                createdAt: row.session_created_at,
                lastUsedAt: now,
                idleExpiresAt,
                absoluteExpiresAt: row.absolute_expires_at,
            }
        })()
    }

    verifyWebSessionCsrf(sessionId: string, csrfToken: string): boolean {
        const row = this.db
            .query(
                'SELECT csrf_hash,revoked_at,idle_expires_at,absolute_expires_at FROM web_sessions WHERE id=?',
            )
            .get(sessionId) as {
            csrf_hash: string
            revoked_at: number | null
            idle_expires_at: number
            absolute_expires_at: number
        } | null
        const now = Date.now()
        return Boolean(
            row &&
            row.revoked_at === null &&
            row.idle_expires_at > now &&
            row.absolute_expires_at > now &&
            constantTimeEquals(row.csrf_hash, tokenHash(csrfToken)),
        )
    }

    revokeWebSession(workspaceId: string, sessionId: string): boolean {
        return (
            this.db
                .query(
                    'UPDATE web_sessions SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL',
                )
                .run(Date.now(), sessionId, workspaceId).changes > 0
        )
    }

    revokeWebSessionsByAccessKey(accessKeyId: string): number {
        return this.db
            .query(
                'UPDATE web_sessions SET revoked_at=? WHERE access_key_id=? AND revoked_at IS NULL',
            )
            .run(Date.now(), accessKeyId).changes
    }

    issueRunnerPairing(
        input: IssueRunnerPairingInput,
        now: number = Date.now(),
        testOptions?: RunnerPairingTestOptions,
    ): IssuedRunnerPairing {
        if (!input.runnerName || !input.runnerMachineId)
            throw new Error('Runner pairing metadata is required')
        if (!isCanonicalToken(input.runnerToken, 'spr'))
            throw new Error('Runner access key token has an invalid format')
        const publicKey = validatePublicJwk(input.publicJwk)
        if (!publicKey || !isThumbprint(input.publicKeyThumbprint) || !constantTimeEquals(publicKey.thumbprint, input.publicKeyThumbprint))
            throw new Error('Runner public-key metadata is invalid')
        if (input.expiresAt <= now)
            throw new Error('Runner pairing must expire in the future')
        const pendingCount = (this.db
            .query("SELECT COUNT(*) count FROM runner_pairings WHERE state IN ('pending','approved') AND expires_at>?")
            .get(now) as { count: number }).count
        if (pendingCount >= 256) throw new Error('Too many pending runner pairings')
        const runnerTokenHash = tokenHash(input.runnerToken)
        this.db
            .query(
                `UPDATE runner_pairings SET state='expired'
                WHERE runner_token_hash=? AND state IN ('pending', 'approved') AND expires_at<=?`,
            )
            .run(runnerTokenHash, now)
        const existingAccessKey = this.db
            .query('SELECT 1 FROM workspace_access_keys WHERE token_hash=?')
            .get(runnerTokenHash)
        if (existingAccessKey)
            throw new Error('Runner access key token is already registered')
        const deviceCode =
            testOptions?.deviceCode ?? randomBytes(32).toString('base64url')
        if (!isCanonicalToken(deviceCode, ''))
            throw new Error(
                'Device code must contain at least 256 bits of entropy',
            )
        const pollIntervalMs = RUNNER_PAIRING_POLL_INTERVAL_MS
        for (let attempt = 0; attempt < 5; attempt++) {
            const humanCode = testOptions?.humanCode ?? generateHumanCode()
            if (!HUMAN_CODE_PATTERN.test(humanCode))
                throw new Error(
                    'Human pairing code must be exactly 8 Crockford Base32 characters',
                )
            try {
                const id = randomUUID()
                this.db
                    .query(
                        `INSERT INTO runner_pairings
                    (id,state,device_code_hash,human_code,runner_name,runner_machine_id,runner_token_hash,public_jwk,public_key_thumbprint,poll_interval_ms,next_poll_at,created_at,expires_at)
                    VALUES(?,'pending',?,?,?,?,?,?,?,?,?,?,?)`,
                    )
                    .run(
                        id,
                        tokenHash(deviceCode),
                        humanCode,
                        input.runnerName,
                        input.runnerMachineId,
                        runnerTokenHash,
                        publicKey.canonical,
                        publicKey.thumbprint,
                        pollIntervalMs,
                        now + pollIntervalMs,
                        now,
                        input.expiresAt,
                    )
                return { ...this.getRunnerPairing(id, now)!, deviceCode }
            } catch (error) {
                if (
                    attempt === 4 ||
                    testOptions?.humanCode ||
                    !String(error).includes(
                        'UNIQUE constraint failed: runner_pairings.human_code',
                    )
                )
                    throw error
            }
        }
        throw new Error('Unable to allocate a unique human pairing code')
    }

    getRunnerPairing(
        id: string,
        now: number = Date.now(),
    ): RunnerPairing | null {
        const row = this.db
            .query(
                `SELECT id,workspace_id,access_key_id,state,human_code,runner_name,runner_machine_id,public_jwk,public_key_thumbprint,
            poll_interval_ms,last_poll_at,next_poll_at,poll_violations,created_at,expires_at,approved_at,denied_at,consumed_at FROM runner_pairings WHERE id=?`,
            )
            .get(id) as PairingRow | null
        if (!row) return null
        if (
            (row.state === 'pending' || row.state === 'approved') &&
            row.expires_at <= now
        ) {
            this.db
                .query(
                    "UPDATE runner_pairings SET state='expired' WHERE id=? AND state IN ('pending', 'approved') AND expires_at<=?",
                )
                .run(id, now)
            row.state = 'expired'
        }
        return pairingFromRow(row)
    }

    getRunnerPairingByDeviceCode(
        deviceCode: string,
        now: number = Date.now(),
    ): RunnerPairing | null {
        if (!isCanonicalToken(deviceCode, '')) return null
        const row = this.db
            .query('SELECT id FROM runner_pairings WHERE device_code_hash=?')
            .get(tokenHash(deviceCode)) as { id: string } | null
        return row ? this.getRunnerPairing(row.id, now) : null
    }

    getRunnerPairingByHumanCode(
        humanCode: string,
        now: number = Date.now(),
    ): RunnerPairing | null {
        if (!HUMAN_CODE_PATTERN.test(humanCode)) return null
        const row = this.db
            .query('SELECT id FROM runner_pairings WHERE human_code=?')
            .get(humanCode) as { id: string } | null
        return row ? this.getRunnerPairing(row.id, now) : null
    }

    approveRunnerPairing(
        workspaceId: string,
        pairingId: string,
        now: number = Date.now(),
    ): RunnerPairing | null {
        return this.db.transaction(() => {
            this.assertWorkspace(workspaceId)
            const changes = this.db
                .query(
                    `UPDATE runner_pairings SET workspace_id=?,state='approved',approved_at=?
                WHERE id=? AND workspace_id IS NULL AND state='pending' AND expires_at>?`,
                )
                .run(workspaceId, now, pairingId, now).changes
            return changes === 1 ? this.getRunnerPairing(pairingId, now) : null
        })()
    }

    denyRunnerPairing(pairingId: string, now: number = Date.now()): boolean {
        return (
            this.db
                .query(
                    `UPDATE runner_pairings SET state='denied',denied_at=?
            WHERE id=? AND workspace_id IS NULL AND state='pending' AND expires_at>?`,
                )
                .run(now, pairingId, now).changes > 0
        )
    }

    pollPairing(
        deviceCode: string,
        now: number = Date.now(),
    ): RunnerPairingPollResult {
        if (!isCanonicalToken(deviceCode, ''))
            return { status: 'expired' }
        return this.db.transaction((): RunnerPairingPollResult => {
            const row = this.db
                .query(
                    `SELECT id,workspace_id,access_key_id,state,human_code,runner_name,runner_machine_id,runner_token_hash,public_jwk,public_key_thumbprint,
                poll_interval_ms,last_poll_at,next_poll_at,poll_violations,created_at,expires_at,approved_at,denied_at,consumed_at,device_code_hash FROM runner_pairings WHERE device_code_hash=?`,
                )
                .get(tokenHash(deviceCode)) as PairingSecretRow | null
            if (!row) return { status: 'expired' }
            if (
                (row.state === 'pending' || row.state === 'approved') &&
                row.expires_at <= now
            ) {
                this.db
                    .query(
                        "UPDATE runner_pairings SET state='expired' WHERE id=? AND state IN ('pending', 'approved')",
                    )
                    .run(row.id)
                return { status: 'expired' }
            }
            if (row.state === 'consumed')
                return {
                    status: 'consumed',
                    accessKeyId: row.access_key_id ?? undefined,
                }
            if (row.state === 'denied' || row.state === 'expired')
                return { status: row.state }
            if (now < row.next_poll_at) {
                const nextPollAt =
                    Math.max(row.next_poll_at, now) + row.poll_interval_ms
                this.db
                    .query(
                        'UPDATE runner_pairings SET poll_violations=poll_violations+1,next_poll_at=? WHERE id=?',
                    )
                    .run(nextPollAt, row.id)
                return { status: 'slow_down', retryAfterMs: nextPollAt - now }
            }
            this.db
                .query(
                    'UPDATE runner_pairings SET last_poll_at=?,next_poll_at=? WHERE id=?',
                )
                .run(now, now + row.poll_interval_ms, row.id)
            return { status: row.state }
        })()
    }

    consumeApprovedRunnerPairing(
        deviceCode: string,
        now: number = Date.now(),
    ): RunnerPairing | null {
        if (!isCanonicalToken(deviceCode, '')) return null
        return this.db.transaction(() => {
            const row = this.db
                .query(
                    `SELECT id,workspace_id,access_key_id,state,human_code,runner_name,runner_machine_id,runner_token_hash,public_jwk,public_key_thumbprint,
                poll_interval_ms,last_poll_at,next_poll_at,poll_violations,created_at,expires_at,approved_at,denied_at,consumed_at,device_code_hash FROM runner_pairings WHERE device_code_hash=?`,
                )
                .get(tokenHash(deviceCode)) as PairingSecretRow | null
            if (!row) return null
            if (row.state === 'consumed') return pairingFromRow(row)
            if (
                row.state === 'pending' ||
                row.state === 'denied' ||
                row.state === 'expired' ||
                !row.workspace_id
            )
                return null
            if (row.expires_at <= now) {
                this.db
                    .query(
                        "UPDATE runner_pairings SET state='expired' WHERE id=? AND state='approved'",
                    )
                    .run(row.id)
                return null
            }
            this.assertAccessKeyCapacity(row.workspace_id, now)
            const accessKeyId = randomUUID()
            this.db
                .query(
                    `INSERT INTO workspace_access_keys
                (id,workspace_id,kind,name,token_hash,created_at,bound_machine_id,public_jwk,public_key_thumbprint)
                VALUES(?,?, 'runner',?,?,?,?,?,?)`,
                )
                .run(
                    accessKeyId,
                    row.workspace_id,
                    row.runner_name,
                    row.runner_token_hash,
                    now,
                    row.runner_machine_id,
                    row.public_jwk,
                    row.public_key_thumbprint,
                )
            const changes = this.db
                .query(
                    `UPDATE runner_pairings SET state='consumed',access_key_id=?,consumed_at=?
                WHERE id=? AND state='approved' AND expires_at>?`,
                )
                .run(accessKeyId, now, row.id, now).changes
            if (changes === 0)
                throw new Error('Runner pairing consume race lost')
            return pairingFromRow({
                ...row,
                access_key_id: accessKeyId,
                state: 'consumed',
                consumed_at: now,
            })
        })()
    }

    private assertWorkspace(workspaceId: string): void {
        if (!this.get(workspaceId)) throw new Error('Workspace not found')
    }

    private assertAccessKeyCapacity(
        workspaceId: string,
        now: number = Date.now(),
    ): void {
        const activeCount = (
            this.db
                .query(
                    `SELECT COUNT(*) count FROM workspace_access_keys
            WHERE workspace_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
                )
                .get(workspaceId, now) as { count: number }
        ).count
        if (activeCount >= 32)
            throw new Error('Workspace access key limit reached')
    }
}
