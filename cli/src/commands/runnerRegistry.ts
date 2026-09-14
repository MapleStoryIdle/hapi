import chalk from 'chalk'
import { createCommandResolver } from './registryBase'
import type { CommandDefinition } from './types'

const unavailableHubCommand: CommandDefinition = {
    name: 'hub',
    requiresRuntimeAssets: false,
    run: async () => {
        console.error(chalk.red('Error:'), 'This Runner-only build cannot start a Hub.')
        process.exit(1)
    }
}

export const resolveRunnerCommand = createCommandResolver([
    unavailableHubCommand,
    { ...unavailableHubCommand, name: 'server' }
])
