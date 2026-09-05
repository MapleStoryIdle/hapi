import type { SyncEngine } from '../sync/syncEngine'
import { LocalServiceManager } from './manager'
import { createLocalServiceGateway } from './gateway'

function envPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
    const value = env[key] ?? String(fallback)
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error(`Invalid ${key}`)
    return Number(value)
}

/** Opt-in infrastructure. A normal Hub starts no additional listeners. */
export async function startLocalServices(
    getSyncEngine: () => SyncEngine | null,
    appUrl: string,
    env: NodeJS.ProcessEnv = process.env
): Promise<{ manager: LocalServiceManager; stop: () => Promise<void> } | null> {
    const originTemplate = env.HAPI_LOCAL_SERVICE_ORIGIN
    if (!originTemplate) return null
    const manager = new LocalServiceManager({
        originTemplate,
        appUrl,
        sshHost: env.HAPI_LOCAL_SERVICE_SSH_HOST || new URL(appUrl).hostname.replace(/^\[|\]$/g, ''),
        sshListenHost: env.HAPI_LOCAL_SERVICE_SSH_BIND || '127.0.0.1',
        sshPort: envPort(env, 'HAPI_LOCAL_SERVICE_SSH_PORT', 8320),
        openTunnel: async (machineId, request) => {
            const engine = getSyncEngine()
            if (!engine) return { ok: false, error: 'Hub is not connected' }
            return await engine.openLocalServiceTunnel(machineId, request)
        },
        canAccessMachine: (identity, machineId) => {
            const machine = getSyncEngine()?.getMachine(machineId)
            return machine?.namespace === identity.namespace && machine.active
        }
    })
    let gateway: ReturnType<typeof createLocalServiceGateway> | null = null
    try {
        await manager.start()
        gateway = createLocalServiceGateway(manager, envPort(env, 'HAPI_LOCAL_SERVICE_GATEWAY_PORT', 8321))
    } catch (error) {
        gateway?.stop(true)
        await manager.stop()
        throw error
    }
    return { manager, stop: async () => {
        await gateway?.stop(true)
        await manager.stop()
    } }
}
