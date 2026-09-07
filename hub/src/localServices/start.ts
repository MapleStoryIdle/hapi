import type { SyncEngine } from '../sync/syncEngine'
import { LocalServiceManager } from './manager'
import { createLocalServiceGateway, createLocalServiceHandler, type LocalServiceHandler } from './gateway'

function envPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const value = env[key] ?? String(fallback)
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error(`Invalid ${key}`)
    return Number(value)
}

/** Opt-in infrastructure. A normal Hub starts no additional listeners. */
export async function startLocalServices(
    getSyncEngine: () => SyncEngine | null,
    appUrl: string,
    env: NodeJS.ProcessEnv = process.env,
    frameOrigins: readonly string[] = []
): Promise<{ manager: LocalServiceManager; pathHandler: LocalServiceHandler | null; stop: () => Promise<void> } | null> {
    const originTemplate = env.HAPI_LOCAL_SERVICE_ORIGIN
    const mode = env.HAPI_LOCAL_SERVICE_MODE ?? (originTemplate ? 'domain' : 'off')
    if (mode === 'off') return null
    if (mode !== 'path' && mode !== 'domain') throw new Error('HAPI_LOCAL_SERVICE_MODE must be path, domain, or off')
    const manager = new LocalServiceManager({
        mode,
        originTemplate,
        appUrl,
        frameOrigins,
        openTunnel: async (machineId, request, namespace) => {
            const engine = getSyncEngine()
            if (!engine) throw new Error('Hub is not connected')
            return await engine.openLocalServiceTunnel(machineId, request, namespace)
        },
        canAccessMachine: (identity, machineId) => {
            const machine = getSyncEngine()?.getMachine(machineId)
            return machine?.namespace === identity.namespace && machine.active
        }
    })
    let gateway: ReturnType<typeof createLocalServiceGateway> | null = null
    let pathHandler: LocalServiceHandler | null = null
    try {
        await manager.start()
        if (mode === 'path') pathHandler = createLocalServiceHandler(manager)
        else gateway = createLocalServiceGateway(manager, envPort(env, 'HAPI_LOCAL_SERVICE_GATEWAY_PORT', 8321))
    } catch (error) {
        gateway?.stop(true)
        await manager.stop()
        throw error
    }
    return { manager, pathHandler, stop: async () => {
        pathHandler?.stop()
        await gateway?.stop(true)
        await manager.stop()
    } }
}
