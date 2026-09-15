import chalk from 'chalk'
import { authCommand } from './auth'
import { claudeCommand } from './claude'
import { codexCommand } from './codex'
import { cursorCommand } from './cursor'
import { connectCommand } from './connect'
import { runnerCommand } from './runner'
import { resumeCommand } from './resume'
import { doctorCommand } from './doctor'
import { kimiCommand } from './kimi'
import { opencodeCommand } from './opencode'
import { piCommand } from './pi'
import { hookForwarderCommand } from './hookForwarder'
import { mcpCommand } from './mcp'
import { notifyCommand } from './notify'
import { inspectPeerCommand } from './inspectPeer'
import { pingPeerCommand } from './pingPeer'
import { shareCommand } from './share'
import { workspaceCommand } from './workspace'
import { uninstallCommand } from './uninstall'
import type { CommandContext, CommandDefinition } from './types'

const removedGeminiCommand: CommandDefinition = {
    name: 'gemini',
    requiresRuntimeAssets: false,
    run: async () => {
        console.error(
            chalk.red('Error:'),
            'Gemini CLI is no longer supported and cannot be launched (Google sunset the consumer Gemini CLI on 2026-06-18). Existing Gemini sessions remain viewable in the web UI.'
        )
        process.exit(1)
    }
}

const removedArtifactCommand: CommandDefinition = {
    name: 'artifact',
    requiresRuntimeAssets: false,
    run: async () => {
        console.error(chalk.red('Error:'), 'shapi artifact was replaced by shapi share. Use `shapi share publish <relative-file>` instead.')
        process.exit(1)
    }
}

const BASE_COMMANDS: CommandDefinition[] = [
    authCommand,
    workspaceCommand,
    uninstallCommand,
    connectCommand,
    codexCommand,
    cursorCommand,
    removedGeminiCommand,
    kimiCommand,
    opencodeCommand,
    piCommand,
    mcpCommand,
    hookForwarderCommand,
    doctorCommand,
    resumeCommand,
    runnerCommand,
    notifyCommand,
    inspectPeerCommand,
    pingPeerCommand,
    removedArtifactCommand,
    shareCommand
]

export function createCommandResolver(additionalCommands: CommandDefinition[] = []) {
    const commandMap = new Map<string, CommandDefinition>()
    for (const command of [...BASE_COMMANDS, ...additionalCommands]) {
        commandMap.set(command.name, command)
    }

    return (args: string[]): { command: CommandDefinition; context: CommandContext } => {
        const subcommand = args[0]
        const command = subcommand ? commandMap.get(subcommand) : undefined
        const resolvedCommand = command ?? claudeCommand
        const commandArgs = command ? args.slice(1) : args

        return {
            command: resolvedCommand,
            context: {
                args,
                subcommand,
                commandArgs
            }
        }
    }
}
