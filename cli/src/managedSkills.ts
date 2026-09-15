import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configuration } from '@/configuration'
import {
    ManagedSkillIdSchema,
    MANAGED_SKILL_MAX_BYTES,
    ManagedSkillPayloadSchema,
    type ManagedSkillPayload,
    type ManagedSkillReconcileResponse,
    type ManagedSkillStatus
} from '@hapi/protocol'

const MARKER_FILE = '.shapi-managed.json'
type Marker = { id: string; version: string; sha256: string; managedBy: 'shapi' }

function digest(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function managedSkillsRoot(): string {
    return join(configuration.happyHomeDir, 'managed-skills')
}

function skillRoot(id: string): string {
    return join(managedSkillsRoot(), id)
}

async function exists(path: string): Promise<boolean> {
    return access(path).then(() => true, () => false)
}

async function readMarker(path: string): Promise<Marker | null> {
    try {
        const value = JSON.parse(await readFile(join(path, MARKER_FILE), 'utf8')) as Partial<Marker>
        return value.managedBy === 'shapi' && typeof value.id === 'string' && typeof value.version === 'string' && typeof value.sha256 === 'string'
            ? value as Marker
            : null
    } catch {
        return null
    }
}

export async function getManagedSkillStatus(id: string): Promise<ManagedSkillStatus> {
    if (!ManagedSkillIdSchema.safeParse(id).success) return { id: 'invalid', version: null, sha256: null, state: 'error', error: 'Invalid managed skill id' }
    const root = skillRoot(id)
    if (!await exists(root)) return { id, version: null, sha256: null, state: 'missing' }
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { id, version: null, sha256: null, state: 'conflict', error: 'Managed skill cache path is unsafe' }
    const marker = await readMarker(root)
    if (!marker || marker.id !== id) return { id, version: null, sha256: null, state: 'conflict', error: 'Unmanaged content occupies the skill cache path' }
    const content = await readFile(join(root, 'SKILL.md'), 'utf8').catch(() => null)
    if (content === null || digest(content) !== marker.sha256) return { id, version: marker.version, sha256: marker.sha256, state: 'conflict', error: 'Cached skill content was modified' }
    return { id, version: marker.version, sha256: marker.sha256, state: 'ready' }
}

export async function reconcileManagedSkill(input: unknown): Promise<ManagedSkillReconcileResponse> {
    const payload = ManagedSkillPayloadSchema.parse(input)
    if (Buffer.byteLength(payload.content, 'utf8') > MANAGED_SKILL_MAX_BYTES || digest(payload.content) !== payload.sha256) throw new Error('Managed skill content failed integrity validation')
    const target = skillRoot(payload.id)
    const parent = dirname(target)
    const suffix = `${process.pid}-${Date.now()}`
    const staging = join(parent, `.${payload.id}.staging-${suffix}`)
    const backup = join(parent, `.${payload.id}.backup-${suffix}`)
    try {
        if (await exists(target)) {
            const current = await getManagedSkillStatus(payload.id)
            if (current.state === 'conflict') throw new Error(current.error)
        }
        await mkdir(parent, { recursive: true, mode: 0o700 })
        await mkdir(staging, { mode: 0o700 })
        await writeFile(join(staging, 'SKILL.md'), payload.content, { mode: 0o600 })
        await writeFile(join(staging, MARKER_FILE), JSON.stringify({ id: payload.id, version: payload.version, sha256: payload.sha256, managedBy: 'shapi' } satisfies Marker, null, 4), { mode: 0o600 })
        if (await exists(target)) await rename(target, backup)
        await rename(staging, target)
        await rm(backup, { recursive: true, force: true })
        return { success: true, status: await getManagedSkillStatus(payload.id) }
    } catch (error) {
        if (!await exists(target) && await exists(backup)) await rename(backup, target).catch(() => {})
        return { success: false, status: { id: payload.id, version: null, sha256: null, state: 'error', error: error instanceof Error ? error.message : 'Skill cache update failed' } }
    } finally {
        await rm(staging, { recursive: true, force: true })
    }
}

export async function removeManagedSkill(input: unknown): Promise<ManagedSkillReconcileResponse> {
    const id = ManagedSkillIdSchema.parse((input as { id?: unknown } | null)?.id)
    const current = await getManagedSkillStatus(id)
    if (current.state === 'conflict') return { success: false, status: current }
    await rm(skillRoot(id), { recursive: true, force: true })
    return { success: true, status: { id, version: null, sha256: null, state: 'missing' } }
}

export async function listManagedSkillInventory(): Promise<Record<string, { version: string; sha256: string; state: 'ready' | 'missing' | 'outdated' | 'conflict' | 'error' }>> {
    const entries = await readdir(managedSkillsRoot(), { withFileTypes: true }).catch(() => [])
    const result: Record<string, { version: string; sha256: string; state: 'ready' | 'missing' | 'outdated' | 'conflict' | 'error' }> = {}
    for (const entry of entries) {
        if (!entry.isDirectory() || !ManagedSkillIdSchema.safeParse(entry.name).success) continue
        const status = await getManagedSkillStatus(entry.name)
        if (status.version && status.sha256) result[entry.name] = { version: status.version, sha256: status.sha256, state: status.state }
    }
    return result
}

/** Expand only a leading skill token selected by SHAPI. Agent-native skill directories are never touched. */
export function expandManagedSkillInvocation(text: string): string {
    const match = text.match(/^\$([a-z][a-z0-9-]{0,63})(?:\s+|$)/)
    const id = match?.[1]
    if (!id) return text
    try {
        const root = skillRoot(id)
        const marker = JSON.parse(readFileSync(join(root, MARKER_FILE), 'utf8')) as Marker
        const content = readFileSync(join(root, 'SKILL.md'), 'utf8')
        if (marker.managedBy !== 'shapi' || marker.id !== id || digest(content) !== marker.sha256) return text
        const request = text.slice(match![0].length).trim()
        return `<shapi-managed-skill id="${id}" version="${marker.version}">\n${content}\n</shapi-managed-skill>\n\nUser request:\n${request || `Apply the ${id} skill.`}`
    } catch {
        return text
    }
}
