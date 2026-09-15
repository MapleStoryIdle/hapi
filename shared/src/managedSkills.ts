import { z } from 'zod'

export const MANAGED_SKILL_MAX_BYTES = 64 * 1024

export const ManagedSkillIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const ManagedSkillVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
export const ManagedSkillDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const ManagedSkillPayloadSchema = z.object({
    id: ManagedSkillIdSchema,
    version: ManagedSkillVersionSchema,
    sha256: ManagedSkillDigestSchema,
    content: z.string().min(1).max(MANAGED_SKILL_MAX_BYTES)
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

export type ManagedSkillDefinition = {
    id: string
    name: string
    description: string
    version: string
    minimumRunnerVersion: string
    content: string
}

export type ManagedSkillCatalogEntry = Omit<ManagedSkillDefinition, 'content'> & { sha256: string }
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
