import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type Socket } from 'socket.io'
import { io as connect, type Socket as ClientSocket } from 'socket.io-client'
import { LOCAL_SERVICE_RPC, type LocalServiceTunnelRequest, type LocalServiceTunnelResponse } from '@hapi/protocol/localServices'
import { localServiceSocketWire, type LocalServiceWire } from '@hapi/protocol/localServiceTransport'
import { openLocalServiceSocketTunnel, type LocalServiceTunnel } from './socketTransport'

// Actual Runner + Socket.IO transport, not an in-memory proxy mock. Test/dev use only.
const { LocalServiceTunnels } = await import(new URL('../../../cli/src/runner/localServiceTunnels.ts', import.meta.url).href) as {
    LocalServiceTunnels: new (blockedPorts?: () => number[]) => {
        attach: (wire: LocalServiceWire) => void
        open: (request: LocalServiceTunnelRequest) => Promise<LocalServiceTunnelResponse>
        dispose: () => void
    }
}

export type LocalServiceSocketFixture = {
    runner: InstanceType<typeof LocalServiceTunnels>
    client: ClientSocket
    reconnect: () => Promise<void>
    readonly serverSocket: Socket
    openTunnel: (id: string, request: LocalServiceTunnelRequest, namespace?: string) => Promise<LocalServiceTunnel>
    close: () => Promise<void>
}

export async function localServiceSocketFixture(machineId = 'machine', blockedPorts: () => number[] = () => []): Promise<LocalServiceSocketFixture> {
    const io = new Server()
    const engine = new Engine({ path: '/socket.io/' })
    io.bind(engine)
    const server = Bun.serve({ ...engine.handler(), hostname: '127.0.0.1', port: 0 })
    const runner = new LocalServiceTunnels(blockedPorts)
    let serverSocket: Socket
    io.of('/cli').on('connection', (socket) => {
        socket.data.namespace = 'owner'
        serverSocket = socket
    })
    const client = connect(`http://127.0.0.1:${server.port}/cli`, {
        transports: ['websocket'], autoConnect: false, reconnection: false,
        auth: { machineId, clientType: 'machine-scoped' }
    })
    client.on('connect', () => runner.attach(localServiceSocketWire(client)))
    client.on('rpc-request', async (request: { method: string; params: string }, ack: (result: string) => void) => {
        ack(JSON.stringify(request.method === `${machineId}:${LOCAL_SERVICE_RPC}` ? await runner.open(JSON.parse(request.params)) : { ok: false }))
    })
    const reconnect = () => new Promise<void>((resolve, reject) => {
        client.once('connect', resolve)
        client.once('connect_error', reject)
        client.connect()
    })
    await reconnect()
    return {
        runner, client, reconnect,
        get serverSocket() { return serverSocket! },
        openTunnel: (id: string, request: LocalServiceTunnelRequest, namespace = 'owner') => openLocalServiceSocketTunnel(serverSocket!, id, namespace, request),
        async close() {
            client.disconnect()
            runner.dispose()
            void io.close()
            await server.stop(true)
        }
    }
}
