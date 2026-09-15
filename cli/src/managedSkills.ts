import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { configuration } from '@/configuration'
import {
    ManagedSkillIdSchema,
    MANAGED_SKILL_MAX_BUNDLE_BYTES,
    MANAGED_SKILL_MAX_FILE_BYTES,
    ManagedSkillPayloadSchema,
    type ManagedSkillFile,
    type ManagedSkillPayload,
    type ManagedSkillReconcileResponse,
    type ManagedSkillStatus
} from '@hapi/protocol'

const MARKER_FILE = '.shapi-managed.json'
const ALLOWED_ROOT_DIRECTORIES = new Set(['agents', 'assets', 'references', 'scripts'])

type MarkerFile = Pick<ManagedSkillFile, 'path' | 'sha256' | 'executable'>
type Marker = {
    id: string
    version: string
    sha256: string
    managedBy: 'shapi'
    files?: MarkerFile[]
}

type DecodedSkillFile = MarkerFile & { content: Buffer }

function digest(content: Uint8Array | string): string {
    return createHash('sha256').update(content).digest('hex')
}

function bundleDigest(files: MarkerFile[]): string {
    const manifest = files
        .map(({ path, sha256, executable }) => ({ path, sha256, executable }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return digest(JSON.stringify(manifest))
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

function isSafeSkillPath(path: string): boolean {
    if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false
    const segments = path.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false
    if (path === 'SKILL.md') return true
    return segments.length > 1 && ALLOWED_ROOT_DIRECTORIES.has(segments[0]!)
}

function isMarkerFile(value: unknown): value is MarkerFile {
    if (!value || typeof value !== 'object') return false
    const file = value as Partial<MarkerFile>
    return typeof file.path === 'string'
        && typeof file.sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(file.sha256)
        && typeof file.executable === 'boolean'
}

async function readMarker(path: string): Promise<Marker | null> {
    try {
        const value = JSON.parse(await readFile(join(path, MARKER_FILE), 'utf8')) as Partial<Marker>
        if (value.managedBy !== 'shapi'
            || typeof value.id !== 'string'
            || typeof value.version !== 'string'
            || typeof value.sha256 !== 'string') return null
        if (value.files !== undefined && (!Array.isArray(value.files) || !value.files.every(isMarkerFile))) return null
        return value as Marker
    } catch {
        return null
    }
}

async function listCachedFiles(root: string, current: string = root): Promise<string[]> {
    const result: string[] = []
    for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name)
        if (entry.isSymbolicLink()) throw new Error('Managed skill cache contains a symbolic link')
        if (entry.isDirectory()) {
            result.push(...await listCachedFiles(root, absolute))
            continue
        }
        if (!entry.isFile()) throw new Error('Managed skill cache contains an unsupported entry')
        result.push(relative(root, absolute).split(sep).join('/'))
    }
    return result.sort((left, right) => left.localeCompare(right))
}

async function validateCachedBundle(root: string, marker: Marker): Promise<boolean> {
    if (!marker.files) {
        const content = await readFile(join(root, 'SKILL.md')).catch(() => null)
        return content !== null && digest(content) === marker.sha256
    }
    if (marker.files.length === 0 || bundleDigest(marker.files) !== marker.sha256) return false
    const expected = new Set<string>()
    for (const file of marker.files) {
        if (!isSafeSkillPath(file.path) || expected.has(file.path)) return false
        expected.add(file.path)
        const absolute = join(root, ...file.path.split('/'))
        const stat = await lstat(absolute).catch(() => null)
        if (!stat?.isFile() || stat.isSymbolicLink()) return false
        const content = await readFile(absolute)
        if (digest(content) !== file.sha256) return false
        if (process.platform !== 'win32' && file.executable !== ((stat.mode & 0o111) !== 0)) return false
    }
    if (!expected.has('SKILL.md')) return false
    const actual = (await listCachedFiles(root)).filter((path) => path !== MARKER_FILE)
    return actual.length === expected.size && actual.every((path) => expected.has(path))
}

export async function getManagedSkillStatus(id: string): Promise<ManagedSkillStatus> {
    if (!ManagedSkillIdSchema.safeParse(id).success) return { id: 'invalid', version: null, sha256: null, state: 'error', error: 'Invalid managed skill id' }
    const root = skillRoot(id)
    if (!await exists(root)) return { id, version: null, sha256: null, state: 'missing' }
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { id, version: null, sha256: null, state: 'conflict', error: 'Managed skill cache path is unsafe' }
    const marker = await readMarker(root)
    if (!marker || marker.id !== id) return { id, version: null, sha256: null, state: 'conflict', error: 'Unmanaged content occupies the skill cache path' }
    try {
        if (!await validateCachedBundle(root, marker)) {
            return { id, version: marker.version, sha256: marker.sha256, state: 'conflict', error: 'Cached skill bundle was modified' }
        }
    } catch (error) {
        return { id, version: marker.version, sha256: marker.sha256, state: 'conflict', error: error instanceof Error ? error.message : 'Cached skill bundle is invalid' }
    }
    return { id, version: marker.version, sha256: marker.sha256, state: 'ready' }
}

function decodePayload(payload: ManagedSkillPayload): DecodedSkillFile[] {
    const seen = new Set<string>()
    const decoded: DecodedSkillFile[] = []
    let totalBytes = 0
    for (const file of payload.files) {
        if (!isSafeSkillPath(file.path)) throw new Error(`Unsafe managed skill path: ${file.path}`)
        if (seen.has(file.path)) throw new Error(`Duplicate managed skill path: ${file.path}`)
        if (file.executable && !file.path.startsWith('scripts/')) throw new Error(`Only scripts may be executable: ${file.path}`)
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
            throw new Error(`Invalid base64 content: ${file.path}`)
        }
        const content = Buffer.from(file.contentBase64, 'base64')
        if (file.path === 'SKILL.md' && content.byteLength === 0) throw new Error('Managed skill SKILL.md is empty')
        if (content.byteLength > MANAGED_SKILL_MAX_FILE_BYTES) throw new Error(`Managed skill file is too large: ${file.path}`)
        if (digest(content) !== file.sha256) throw new Error(`Managed skill file failed integrity validation: ${file.path}`)
        totalBytes += content.byteLength
        if (totalBytes > MANAGED_SKILL_MAX_BUNDLE_BYTES) throw new Error('Managed skill bundle is too large')
        seen.add(file.path)
        decoded.push({ path: file.path, sha256: file.sha256, executable: file.executable, content })
    }
    if (!seen.has('SKILL.md')) throw new Error('Managed skill bundle is missing SKILL.md')
    if (bundleDigest(decoded) !== payload.sha256) throw new Error('Managed skill bundle failed integrity validation')
    return decoded.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

export async function reconcileManagedSkill(input: unknown): Promise<ManagedSkillReconcileResponse> {
    const payload = ManagedSkillPayloadSchema.parse(input)
    let files: DecodedSkillFile[]
    try {
        files = decodePayload(payload)
    } catch (error) {
        return { success: false, status: { id: payload.id, version: null, sha256: null, state: 'error', error: error instanceof Error ? error.message : 'Skill bundle validation failed' } }
    }
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
        for (const file of files) {
            const output = join(staging, ...file.path.split('/'))
            await mkdir(dirname(output), { recursive: true, mode: 0o700 })
            await writeFile(output, file.content, { mode: file.executable ? 0o700 : 0o600 })
        }
        const markerFiles = files.map(({ path, sha256, executable }) => ({ path, sha256, executable }))
        await writeFile(join(staging, MARKER_FILE), JSON.stringify({
            id: payload.id,
            version: payload.version,
            sha256: payload.sha256,
            managedBy: 'shapi',
            files: markerFiles
        } satisfies Marker, null, 4), { mode: 0o600 })
        if (await exists(target)) await rename(target, backup)
        await rename(staging, target)
        await rm(backup, { recursive: true, force: true }).catch(() => {})
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
        const content = readFileSync(join(root, 'SKILL.md'))
        const skillFile = marker.files?.find((file) => file.path === 'SKILL.md')
        const expectedDigest = skillFile?.sha256 ?? marker.sha256
        if (marker.managedBy !== 'shapi' || marker.id !== id || digest(content) !== expectedDigest) return text
        const request = text.slice(match![0].length).trim()
        return `<shapi-managed-skill id="${id}" version="${marker.version}">\nBundle root: ${root}\nResolve scripts, references, assets, and other relative paths from this bundle root.\n\n${content.toString('utf8')}\n</shapi-managed-skill>\n\nUser request:\n${request || `Apply the ${id} skill.`}`
    } catch {
        return text
    }
}
