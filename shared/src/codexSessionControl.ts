import { z } from 'zod'

/** Per-native-thread preferences for future SHAPI sends, never global Codex settings. */
export const NativeCodexSessionConfigurationSchema = z.object({
    model: z.string().trim().min(1).max(200).nullable().optional(),
    modelReasoningEffort: z.string().trim().min(1).max(40).nullable().optional(),
    serviceTier: z.enum(['standard', 'fast']).nullable().optional()
}).strict()

export type NativeCodexSessionConfiguration = z.infer<typeof NativeCodexSessionConfigurationSchema>

export const NativeCodexSessionControlActionSchema = z.discriminatedUnion('action', [
    z.object({ action: z.literal('stop'), expectedTurnId: z.string().trim().min(1).max(512) }).strict(),
    z.object({ action: z.literal('configure'), configuration: NativeCodexSessionConfigurationSchema }).strict(),
    z.object({ action: z.literal('resumeQueue') }).strict()
])

export type NativeCodexSessionControlAction = z.infer<typeof NativeCodexSessionControlActionSchema>

export const NativeCodexSessionControlsSchema = z.object({
    canStop: z.boolean(),
    canConfigure: z.boolean(),
    configuration: NativeCodexSessionConfigurationSchema,
    queuePaused: z.boolean(),
    /** Cancellation was requested, not yet confirmed by the owning Codex turn. */
    stoppingTurnId: z.string().min(1).max(512).optional(),
    unavailableReason: z.enum(['external_control_unavailable', 'shared_configuration_unsupported', 'unsupported']).optional()
}).strict()
export type NativeCodexSessionControls = z.infer<typeof NativeCodexSessionControlsSchema>

export type NativeCodexSessionControlResponse = {
    success: true
    controls: NativeCodexSessionControls
} | {
    success: false
    code: 'session_not_found' | 'not_native_session' | 'invalid_request' | 'unsupported' | 'turn_changed' | 'control_busy' | 'control_unconfirmed' | 'control_failed' | 'configuration_unsupported'
    error: string
}
