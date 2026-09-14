import { describe, expect, it, vi } from 'vitest'
import { registerLocalHandoffHandler } from './localHandoff'

describe('registerLocalHandoffHandler', () => {
    it('registers handoff-local and schedules clean exit', async () => {
        const handlers = new Map<string, (params?: unknown) => unknown>()
        const rpcHandlerManager: Parameters<typeof registerLocalHandoffHandler>[0] = {
            registerHandler: (method, handler) => {
                handlers.set(method, handler as (params?: unknown) => unknown)
            }
        }
        const lifecycle = {
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            hasExplicitSessionEndReason: vi.fn(() => false),
            cleanupAndExit: vi.fn(async () => {})
        }

        registerLocalHandoffHandler(rpcHandlerManager, lifecycle)
        const handler = handlers.get('handoff-local')

        expect(handler).toBeDefined()
        expect(await handler?.()).toEqual({ ok: true })
        await new Promise((resolve) => setImmediate(resolve))

        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('Handed off to local terminal')
        expect(lifecycle.setSessionEndReason).toHaveBeenCalledWith('handoff')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalledWith(0)
    })

    it('records a distinct reason when releasing for another program', async () => {
        const handlers = new Map<string, (params?: unknown) => unknown>()
        const rpcHandlerManager: Parameters<typeof registerLocalHandoffHandler>[0] = {
            registerHandler: (method, handler) => {
                handlers.set(method, handler as (params?: unknown) => unknown)
            }
        }
        const lifecycle = {
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            hasExplicitSessionEndReason: vi.fn(() => false),
            cleanupAndExit: vi.fn(async () => {})
        }

        registerLocalHandoffHandler(rpcHandlerManager, lifecycle)
        const handler = handlers.get('handoff-local')
        await handler?.({ destination: 'external' })
        await new Promise((resolve) => setImmediate(resolve))

        expect(lifecycle.setArchiveReason).toHaveBeenCalledWith('Released from SHAPI control')
        expect(lifecycle.setSessionEndReason).toHaveBeenCalledWith('handoff')
        expect(lifecycle.cleanupAndExit).toHaveBeenCalledWith(0)
    })

    it('refuses control release when Codex became busy before teardown', async () => {
        const handlers = new Map<string, (params?: unknown) => unknown>()
        const rpcHandlerManager: Parameters<typeof registerLocalHandoffHandler>[0] = {
            registerHandler: (method, handler) => {
                handlers.set(method, handler as (params?: unknown) => unknown)
            }
        }
        const lifecycle = {
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            cleanupAndExit: vi.fn(async () => {})
        }

        registerLocalHandoffHandler(rpcHandlerManager, lifecycle, {
            canReleaseControl: () => 'Codex is processing'
        })
        const handler = handlers.get('handoff-local')

        expect(await handler?.({ destination: 'external' })).toEqual({
            ok: false,
            error: 'Codex is processing'
        })
        await new Promise((resolve) => setImmediate(resolve))
        expect(lifecycle.setArchiveReason).not.toHaveBeenCalled()
        expect(lifecycle.setSessionEndReason).not.toHaveBeenCalled()
        expect(lifecycle.cleanupAndExit).not.toHaveBeenCalled()
    })
})
