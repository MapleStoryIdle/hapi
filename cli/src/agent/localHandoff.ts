import type { SessionEndReason } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'

type RpcHandlerManagerLike = {
    registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: (params: TRequest) => Promise<TResponse> | TResponse
    ): void
}

type LocalHandoffLifecycle = {
    setArchiveReason: (reason: string) => void
    setSessionEndReason: (reason: SessionEndReason) => void
    cleanupAndExit: (codeOverride?: number) => Promise<void>
}

type HandoffRequest = {
    /**
     * `local-terminal` is the historical `shapi resume` path.  `external`
     * intentionally only releases the runner process; it never attempts to
     * launch or drive another program.
     */
    destination?: 'local-terminal' | 'external'
}

type LocalHandoffOptions = {
    /** Only supplied by managed Codex. A string is a definite local refusal. */
    canReleaseControl?: () => string | null
}

export function registerLocalHandoffHandler(
    rpcHandlerManager: RpcHandlerManagerLike,
    lifecycle: LocalHandoffLifecycle,
    options?: LocalHandoffOptions
): void {
    rpcHandlerManager.registerHandler<HandoffRequest>(RPC_METHODS.HandoffLocal, (request) => {
        const destination = request?.destination === 'external' ? 'external' : 'local-terminal'
        if (destination === 'external') {
            const refusal = options?.canReleaseControl?.()
            if (refusal) return { ok: false, error: refusal }
        }
        lifecycle.setArchiveReason(destination === 'external'
            ? 'Released from SHAPI control'
            : 'Handed off to local terminal')
        lifecycle.setSessionEndReason('handoff')
        setImmediate(() => {
            void lifecycle.cleanupAndExit(0)
        })
        return { ok: true }
    })
}
