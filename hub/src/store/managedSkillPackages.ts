import type { Database } from 'bun:sqlite'
import type { ManagedSkillDefinition } from '@hapi/protocol'
import { managedSkillDigest, validateManagedSkillDefinition } from '../managedSkillBundles'

export const MANAGED_SKILL_PACKAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_skill_packages (
    scope_namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    version TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
    source TEXT NOT NULL CHECK(source IN ('bundled', 'published')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope_namespace, id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_managed_skill_packages_active
    ON managed_skill_packages(scope_namespace, id) WHERE active=1;
`

const PUBLIC_SCOPE = ''

export type ManagedSkillPackageVersion = {
    id: string
    name: string
    version: string
    sha256: string
    active: boolean
    source: 'bundled' | 'published'
    createdAt: number
    visibility: 'public' | 'personal'
}

type PackageRow = {
    scope_namespace: string
    id: string
    version: string
    definition_json: string
    sha256: string
    active: number
    source: 'bundled' | 'published'
    created_at: number
}

export class ManagedSkillPackageStore {
    constructor(private readonly db: Database) {}

    private definition(row: Pick<PackageRow, 'definition_json'>): ManagedSkillDefinition {
        return validateManagedSkillDefinition(JSON.parse(row.definition_json) as unknown)
    }

    getActive(id: string, namespace?: string): ManagedSkillDefinition | null {
        const row = this.db.query(`
            SELECT definition_json FROM managed_skill_packages
            WHERE id=? AND active=1 AND scope_namespace IN (?, ?)
            ORDER BY CASE WHEN scope_namespace=? THEN 0 ELSE 1 END
            LIMIT 1
        `).get(id, namespace ?? PUBLIC_SCOPE, PUBLIC_SCOPE, namespace ?? PUBLIC_SCOPE) as Pick<PackageRow, 'definition_json'> | null
        return row ? this.definition(row) : null
    }

    listActive(namespace?: string): Array<{ definition: ManagedSkillDefinition; visibility: 'public' | 'personal' }> {
        const rows = this.db.query(`
            SELECT scope_namespace, definition_json FROM managed_skill_packages
            WHERE active=1 AND scope_namespace IN (?, ?)
            ORDER BY id, CASE WHEN scope_namespace=? THEN 0 ELSE 1 END
        `).all(namespace ?? PUBLIC_SCOPE, PUBLIC_SCOPE, namespace ?? PUBLIC_SCOPE) as Array<Pick<PackageRow, 'scope_namespace' | 'definition_json'>>
        const seen = new Set<string>()
        return rows.flatMap((row) => {
            const definition = this.definition(row)
            if (seen.has(definition.id)) return []
            seen.add(definition.id)
            return [{ definition, visibility: row.scope_namespace === PUBLIC_SCOPE ? 'public' as const : 'personal' as const }]
        })
    }

    listVersions(id?: string, namespace?: string): ManagedSkillPackageVersion[] {
        const scope = namespace ?? PUBLIC_SCOPE
        const rows = (id
            ? this.db.query('SELECT * FROM managed_skill_packages WHERE scope_namespace=? AND id=? ORDER BY created_at DESC, version DESC').all(scope, id)
            : this.db.query('SELECT * FROM managed_skill_packages WHERE scope_namespace=? ORDER BY id, created_at DESC, version DESC').all(scope)) as PackageRow[]
        return rows.map((row) => {
            const definition = this.definition(row)
            return {
                id: row.id,
                name: definition.name,
                version: row.version,
                sha256: row.sha256,
                active: row.active === 1,
                source: row.source,
                createdAt: row.created_at,
                visibility: row.scope_namespace === PUBLIC_SCOPE ? 'public' : 'personal'
            }
        })
    }

    publish(
        input: unknown,
        options: { activate?: boolean; source?: 'bundled' | 'published'; createdAt?: number; namespace?: string } = {}
    ): { definition: ManagedSkillDefinition; sha256: string; created: boolean; active: boolean } {
        const definition = validateManagedSkillDefinition(input)
        const definitionJson = JSON.stringify(definition)
        const sha256 = managedSkillDigest(definition.files)
        const activate = options.activate ?? true
        const source = options.source ?? 'published'
        const createdAt = options.createdAt ?? Date.now()
        const scope = options.namespace ?? PUBLIC_SCOPE
        return this.db.transaction(() => {
            const existing = this.db.query(`
                SELECT definition_json, active FROM managed_skill_packages WHERE scope_namespace=? AND id=? AND version=?
            `).get(scope, definition.id, definition.version) as { definition_json: string; active: number } | null
            if (existing && existing.definition_json !== definitionJson) {
                throw new Error(`Skill ${definition.id}@${definition.version} already exists with different content; publish a new version`)
            }
            if (!existing) {
                this.db.query(`
                    INSERT INTO managed_skill_packages(scope_namespace, id, version, definition_json, sha256, active, source, created_at)
                    VALUES(?,?,?,?,?,0,?,?)
                `).run(scope, definition.id, definition.version, definitionJson, sha256, source, createdAt)
            }
            if (activate) this.activateInTransaction(scope, definition.id, definition.version)
            return { definition, sha256, created: !existing, active: activate || existing?.active === 1 }
        })()
    }

    activate(id: string, version: string, namespace?: string): ManagedSkillDefinition {
        const scope = namespace ?? PUBLIC_SCOPE
        return this.db.transaction(() => {
            const row = this.db.query(`
                SELECT definition_json FROM managed_skill_packages WHERE scope_namespace=? AND id=? AND version=?
            `).get(scope, id, version) as Pick<PackageRow, 'definition_json'> | null
            if (!row) throw new Error(`Skill version not found: ${id}@${version}`)
            this.activateInTransaction(scope, id, version)
            return this.definition(row)
        })()
    }

    seedBundled(definitions: readonly ManagedSkillDefinition[]): void {
        for (const definition of definitions) {
            const hasActive = this.getActive(definition.id) !== null
            this.publish(definition, { activate: !hasActive, source: 'bundled', createdAt: 0 })
        }
    }

    private activateInTransaction(scope: string, id: string, version: string): void {
        this.db.query('UPDATE managed_skill_packages SET active=0 WHERE scope_namespace=? AND id=? AND active=1').run(scope, id)
        const result = this.db.query(`
            UPDATE managed_skill_packages SET active=1 WHERE scope_namespace=? AND id=? AND version=?
        `).run(scope, id, version)
        if (result.changes !== 1) throw new Error(`Skill version not found: ${id}@${version}`)
    }
}
