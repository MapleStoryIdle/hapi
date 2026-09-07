import { describe, expect, it } from 'bun:test'
import { NativeCodexSessionControlActionSchema, NativeCodexSessionControlsSchema } from './codexSessionControl'
import { CodexLocalSessionRealtimeStatusSchema } from './schemas'

describe('native session control contracts', () => {
    it('requires an exact turn id and rejects unrelated settings', () => {
        expect(NativeCodexSessionControlActionSchema.safeParse({ action: 'stop' }).success).toBe(false)
        expect(NativeCodexSessionControlActionSchema.safeParse({ action: 'stop', expectedTurnId: 't'.repeat(512) }).success).toBe(true)
        expect(NativeCodexSessionControlActionSchema.safeParse({ action: 'configure', configuration: { permissionMode: 'bypassPermissions' } }).success).toBe(false)
    })
    it('preserves capabilities, pause and pending stop in realtime validation', () => {
        const controls = { canStop: false, canConfigure: true, configuration: { model: 'gpt-5.6-terra', serviceTier: 'standard' }, queuePaused: true, stoppingTurnId: 'turn-1' }
        expect(NativeCodexSessionControlsSchema.safeParse(controls).success).toBe(true)
        expect(CodexLocalSessionRealtimeStatusSchema.parse({ success: true, status: 'processing', controls }).controls).toEqual(controls)
    })
})
