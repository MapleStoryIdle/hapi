import chalk from 'chalk'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import type { CommandDefinition } from './types'
import { CODEX_PERMISSION_MODES } from '@hapi/protocol/modes'
import type { CodexPermissionMode } from '@hapi/protocol/types'
import type { ReasoningEffort } from '@/codex/appServerTypes'
import { assertCodexLocalSupported } from '@/codex/utils/codexVersion'
import { printHapiCliCapabilities } from './capabilities'

function parseReasoningEffort(value: string): ReasoningEffort {
    switch (value) {
        case 'none':
        case 'minimal':
        case 'low':
        case 'medium':
        case 'high':
        case 'xhigh':
        case 'max':
        case 'ultra':
            return value
        default:
            throw new Error('Invalid --model-reasoning-effort value')
    }
}

// Mirror the web /service-tier endpoint's enum so the internal resume spawn
// path can never seed/persist an unsupported tier string.
function parseServiceTier(value: string): 'fast' | 'standard' {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'fast' || normalized === 'standard') {
        return normalized
    }
    throw new Error('Invalid --service-tier value')
}

function showHelp(): void {
    console.log(`
${chalk.bold('shapi codex')} - Start, resume, or fork a Codex CLI conversation

${chalk.bold('Usage:')}
  shapi codex
  shapi codex resume <session-id>
  shapi codex fork <source-session-id>
  shapi codex notifications enable

${chalk.bold('Fork semantics:')}
  Uses native Codex thread/fork. The source conversation history, model,
  reasoning effort, service tier, and native policy are inherited by Codex.
  SHAPI starts a separate session for the fork; it does not modify the source.
  A remote fork reads the source from the selected runner's own CODEX_HOME;
  that runner must also be allowed to spawn in the transcript workspace.

${chalk.bold('Machine-readable help:')}
  shapi codex --hapi-help-json
`)
}

export const codexCommand: CommandDefinition = {
    name: 'codex',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            if (commandArgs.length === 1 && (commandArgs[0] === '--help' || commandArgs[0] === '-h')) {
                showHelp()
                return
            }
            if (commandArgs.length === 1 && commandArgs[0] === '--hapi-help-json') {
                printHapiCliCapabilities('codex')
                return
            }
            if (commandArgs[0] === 'notifications') {
                if (commandArgs.length !== 2 || commandArgs[1] !== 'enable') {
                    throw new Error('Usage: shapi codex notifications enable')
                }
                const { installExternalCodexNotificationHooks } = await import('@/codex/utils/externalCodexNotificationHooks')
                const result = await installExternalCodexNotificationHooks()
                if (result.addedKinds.length === 0) {
                    console.log(`SHAPI Codex mobile notification hooks are already installed in ${result.hooksPath}`)
                } else {
                    console.log(`Installed SHAPI Codex mobile notification hooks in ${result.hooksPath}`)
                }
                console.log('In Codex, run /hooks once and trust the new SHAPI hooks to activate them.')
                return
            }
            const { runCodex } = await import('@/codex/runCodex')

            const options: {
                startedBy?: 'runner' | 'terminal'
                codexArgs?: string[]
                permissionMode?: CodexPermissionMode
                resumeSessionId?: string
                forkSessionId?: string
                model?: string
                modelReasoningEffort?: ReasoningEffort
                serviceTier?: string
                recoveryRequestId?: string
            } = {}
            const unknownArgs: string[] = []
            let hasExplicitPermissionMode = false

            for (let i = 0; i < commandArgs.length; i++) {
                const arg = commandArgs[i]
                if (i === 0 && arg === 'resume') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('resume requires a session id')
                    }
                    options.resumeSessionId = candidate
                    i += 1
                    continue
                }
                if (i === 0 && arg === 'fork') {
                    const candidate = commandArgs[i + 1]
                    if (!candidate || candidate.startsWith('-')) {
                        throw new Error('fork requires a session id')
                    }
                    options.forkSessionId = candidate
                    i += 1
                    continue
                }
                if (arg === '--started-by') {
                    options.startedBy = commandArgs[++i] as 'runner' | 'terminal'
                } else if (arg === '--permission-mode') {
                    const mode = commandArgs[++i]
                    if (!mode || !(CODEX_PERMISSION_MODES as readonly string[]).includes(mode)) {
                        throw new Error(`Invalid --permission-mode value: ${mode ?? '(missing)'}`)
                    }
                    options.permissionMode = mode as CodexPermissionMode
                    hasExplicitPermissionMode = true
                } else if ((arg === '--yolo' || arg === '--dangerously-bypass-approvals-and-sandbox') && !hasExplicitPermissionMode) {
                    options.permissionMode = 'yolo'
                    unknownArgs.push(arg)
                } else if (arg === '--model') {
                    const model = commandArgs[++i]
                    if (!model) {
                        throw new Error('Missing --model value')
                    }
                    options.model = model
                    unknownArgs.push('--model', model)
                } else if (arg === '--model-reasoning-effort') {
                    const effort = commandArgs[++i]
                    if (!effort) {
                        throw new Error('Missing --model-reasoning-effort value')
                    }
                    options.modelReasoningEffort = parseReasoningEffort(effort)
                } else if (arg === '--service-tier') {
                    const tier = commandArgs[++i]
                    if (!tier) {
                        throw new Error('Missing --service-tier value')
                    }
                    options.serviceTier = parseServiceTier(tier)
                } else if (arg === '--recover-control') {
                    const requestId = commandArgs[++i]
                    if (!requestId || !/^[a-zA-Z0-9:._-]{1,200}$/.test(requestId)) {
                        throw new Error('Invalid --recover-control request id')
                    }
                    options.recoveryRequestId = requestId
                } else {
                    unknownArgs.push(arg)
                }
            }
            if (unknownArgs.length > 0) {
                options.codexArgs = unknownArgs
            }

            if (options.startedBy !== 'runner') {
                assertCodexLocalSupported()
            }

            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()
            await runCodex(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) {
                console.error(error)
            }
            process.exit(1)
        }
    }
}
