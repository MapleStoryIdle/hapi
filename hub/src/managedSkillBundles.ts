import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import {
    MANAGED_SKILL_MAX_BUNDLE_BYTES,
    MANAGED_SKILL_MAX_FILES,
    MANAGED_SKILL_MAX_FILE_BYTES,
    ManagedSkillDefinitionSchema,
    type ManagedSkillDefinition,
    type ManagedSkillFile
} from '@hapi/protocol'

const ALLOWED_ROOT_DIRECTORIES = new Set(['agents', 'assets', 'references', 'scripts'])

export function managedSkillDigest(files: readonly ManagedSkillFile[]): string {
    const manifest = files
        .map(({ path, sha256, executable }) => ({ path, sha256, executable }))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex')
}

function fileDigest(content: Uint8Array): string {
    return createHash('sha256').update(content).digest('hex')
}

function normalizePath(root: string, path: string): string {
    return relative(root, path).split(sep).join('/')
}

function assertBundlePath(path: string): void {
    if (path === 'SKILL.md') return
    const [root, child] = path.split('/')
    if (!root || !child || !ALLOWED_ROOT_DIRECTORIES.has(root)) {
        throw new Error(`Unsupported Skill bundle path: ${path}`)
    }
}

async function collectFiles(root: string, current: string = root): Promise<ManagedSkillFile[]> {
    const result: ManagedSkillFile[] = []
    for (const entry of await readdir(current, { withFileTypes: true })) {
        const absolute = join(current, entry.name)
        const stat = await lstat(absolute)
        const path = normalizePath(root, absolute)
        if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in Skill bundles: ${path}`)
        if (entry.isDirectory()) {
            result.push(...await collectFiles(root, absolute))
            continue
        }
        if (!entry.isFile()) throw new Error(`Unsupported Skill bundle entry: ${path}`)
        if (path === 'hapi.json') continue
        assertBundlePath(path)
        const content = await readFile(absolute)
        if (path === 'SKILL.md' && content.byteLength === 0) throw new Error('SKILL.md must not be empty')
        if (content.byteLength > MANAGED_SKILL_MAX_FILE_BYTES) throw new Error(`Skill file is too large: ${path}`)
        result.push({
            path,
            contentBase64: content.toString('base64'),
            sha256: fileDigest(content),
            executable: path.startsWith('scripts/')
        })
    }
    return result
}

export async function loadManagedSkillBundle(root: string): Promise<ManagedSkillDefinition> {
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Skill bundle root must be a regular directory')
    const metadataInput = JSON.parse(await readFile(join(root, 'hapi.json'), 'utf8')) as unknown
    if (!metadataInput || typeof metadataInput !== 'object') throw new Error('hapi.json must contain an object')
    const metadata = metadataInput as Record<string, unknown>
    const files = (await collectFiles(root)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const definition = ManagedSkillDefinitionSchema.parse({ ...metadata, files })
    if (definition.id !== basename(root)) throw new Error(`Skill id ${definition.id} must match directory ${basename(root)}`)
    if (!files.some((file) => file.path === 'SKILL.md')) throw new Error(`${definition.id} is missing SKILL.md`)
    if (files.length > MANAGED_SKILL_MAX_FILES) throw new Error(`${definition.id} has too many files`)
    const totalBytes = files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, 'base64').byteLength, 0)
    if (totalBytes > MANAGED_SKILL_MAX_BUNDLE_BYTES) throw new Error(`${definition.id} bundle is too large`)
    return definition
}

export function validateManagedSkillDefinition(input: unknown): ManagedSkillDefinition {
    const definition = ManagedSkillDefinitionSchema.parse(input)
    const paths = new Set<string>()
    let totalBytes = 0
    for (const file of definition.files) {
        assertBundlePath(file.path)
        if (paths.has(file.path)) throw new Error(`Duplicate Skill bundle path: ${file.path}`)
        if (file.executable && !file.path.startsWith('scripts/')) throw new Error(`Only scripts may be executable: ${file.path}`)
        const content = Buffer.from(file.contentBase64, 'base64')
        if (file.path === 'SKILL.md' && content.byteLength === 0) throw new Error('SKILL.md must not be empty')
        if (content.byteLength > MANAGED_SKILL_MAX_FILE_BYTES) throw new Error(`Skill file is too large: ${file.path}`)
        if (fileDigest(content) !== file.sha256) throw new Error(`Skill file digest mismatch: ${file.path}`)
        totalBytes += content.byteLength
        paths.add(file.path)
    }
    if (!paths.has('SKILL.md')) throw new Error(`${definition.id} is missing SKILL.md`)
    if (totalBytes > MANAGED_SKILL_MAX_BUNDLE_BYTES) throw new Error(`${definition.id} bundle is too large`)
    return { ...definition, files: [...definition.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0) }
}
