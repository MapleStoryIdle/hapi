import { z } from 'zod'

export const MANAGED_SKILL_MAX_FILES = 128
export const MANAGED_SKILL_MAX_FILE_BYTES = 2 * 1024 * 1024
export const MANAGED_SKILL_MAX_BUNDLE_BYTES = 10 * 1024 * 1024
const MANAGED_SKILL_MAX_ENCODED_FILE_BYTES = Math.ceil(MANAGED_SKILL_MAX_FILE_BYTES / 3) * 4

export const ManagedSkillIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const ManagedSkillVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
export const ManagedSkillDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const ManagedSkillFileSchema = z.object({
    path: z.string().min(1).max(240),
    contentBase64: z.string().max(MANAGED_SKILL_MAX_ENCODED_FILE_BYTES),
    sha256: ManagedSkillDigestSchema,
    executable: z.boolean()
}).strict()

export type ManagedSkillFile = z.infer<typeof ManagedSkillFileSchema>

export const ManagedSkillDefinitionSchema = z.object({
    id: ManagedSkillIdSchema,
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(1000),
    descriptions: z.object({
        en: z.string().min(1).max(1000).optional(),
        'zh-CN': z.string().min(1).max(1000).optional()
    }).strict().optional(),
    version: ManagedSkillVersionSchema,
    minimumRunnerVersion: ManagedSkillVersionSchema,
    files: z.array(ManagedSkillFileSchema).min(1).max(MANAGED_SKILL_MAX_FILES)
}).strict()

export const ManagedSkillPayloadSchema = z.object({
    id: ManagedSkillIdSchema,
    version: ManagedSkillVersionSchema,
    sha256: ManagedSkillDigestSchema,
    files: z.array(ManagedSkillFileSchema).min(1).max(MANAGED_SKILL_MAX_FILES)
}).strict()

export type ManagedSkillPayload = z.infer<typeof ManagedSkillPayloadSchema>

export const ManagedSkillInstallStateSchema = z.enum(['ready', 'missing', 'outdated', 'conflict', 'error'])
export type ManagedSkillInstallState = z.infer<typeof ManagedSkillInstallStateSchema>

export const ManagedSkillStatusSchema = z.object({
    id: ManagedSkillIdSchema,
    version: ManagedSkillVersionSchema.nullable(),
    sha256: ManagedSkillDigestSchema.nullable(),
    state: ManagedSkillInstallStateSchema,
    error: z.string().max(1000).optional()
}).strict()
export type ManagedSkillStatus = z.infer<typeof ManagedSkillStatusSchema>

export const ManagedSkillReconcileResponseSchema = z.object({
    success: z.boolean(),
    status: ManagedSkillStatusSchema
}).strict()
export type ManagedSkillReconcileResponse = z.infer<typeof ManagedSkillReconcileResponseSchema>

export type ManagedSkillDefinition = z.infer<typeof ManagedSkillDefinitionSchema>

export type ManagedSkillCatalogEntry = Omit<ManagedSkillDefinition, 'files'> & {
    sha256: string
    visibility: 'public' | 'personal'
}
export type ManagedSkillMachineState = {
    machineId: string
    displayName: string
    active: boolean
    runnerVersion: string | null
    desiredVersion: string | null
    installedVersion: string | null
    state: 'ready' | 'missing' | 'outdated' | 'conflict' | 'offline' | 'unsupported' | 'error'
    error?: string
}
export type ManagedSkillControlResponse = {
    skills: Array<ManagedSkillCatalogEntry & { enabled: boolean; machines: ManagedSkillMachineState[] }>
}
