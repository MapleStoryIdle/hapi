import type { CommandDefinition } from './types'

export const hookForwarderCommand: CommandDefinition = {
    name: 'hook-forwarder',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        if (commandArgs.includes('--external-codex-request')) {
            const { runExternalCodexHookForwarder } = await import('@/codex/utils/externalCodexHookForwarder')
            await runExternalCodexHookForwarder(commandArgs)
            return
        }
        const { runSessionHookForwarder } = await import('@/claude/utils/sessionHookForwarder')
        await runSessionHookForwarder(commandArgs)
    }
}
