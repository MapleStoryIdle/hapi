import packageJson from '../../package.json'
import { isBunCompiled } from '@/projectPath'
import { logger } from '@/ui/logger'
import { getCliArgs } from '@/utils/cliArgs'
import { ensureLoopbackProxyBypass } from '@/utils/proxyEnv'
import { printHapiCliCapabilities } from './capabilities'
import type { CommandContext, CommandDefinition } from './types'

type CommandResolver = (args: string[]) => { command: CommandDefinition; context: CommandContext }

export async function runCliCore(resolveCommand: CommandResolver, version = packageJson.version): Promise<void> {
    ensureLoopbackProxyBypass()

    const args = getCliArgs()

    if (args.includes('-v') || args.includes('--version')) {
        console.log(`SHAPI version: ${version}`)
        process.exit(0)
    }

    if (args.length === 1 && (args[0] === '--hapi-capabilities' || args[0] === '--help-json')) {
        printHapiCliCapabilities()
        return
    }

    if (isBunCompiled()) {
        process.env.DEV = 'false'
    }

    const { command, context } = resolveCommand(args)

    if (command.requiresRuntimeAssets) {
        const { ensureRuntimeAssets } = await import('@/runtime/assets')
        await ensureRuntimeAssets()
        logger.debug('Starting SHAPI CLI with args: ', process.argv)
    }

    await command.run(context)
}
