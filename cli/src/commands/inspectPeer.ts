import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatInspectPeerReport,
    inspectPeer
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'
import { printHapiCliCapabilities } from './capabilities'

export type ParsedInspectPeerArgs = {
    help: boolean
    sessionIdPrefix?: string
    messageLimit?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi inspect-peer')} - 只读查看同一 Hub 的另一个会话

${chalk.bold('Usage:')}
  hapi inspect-peer <session-id-or-prefix>
  hapi inspect-peer <session-id-or-prefix> --limit 50

${chalk.bold('Machine-readable contract:')}
  输出包含会话元数据和最近可提取的用户 / Agent 文本；该命令绝不会 resume 目标会话。
  可传入 [title](/sessions/<id>) 或 Copy-reference 文本；多个引用会拒绝执行。
`)
}

/** 解析 inspect-peer 参数。 */
export function parseInspectPeerArgs(args: string[]): ParsedInspectPeerArgs {
    const result: ParsedInspectPeerArgs = { help: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
        } else if (arg === '--limit' || arg.startsWith('--limit=')) {
            const value = arg === '--limit' ? args[++i] : arg.slice('--limit='.length)
            if (!value) throw new PingPeerError('bad_args', '--limit requires a number')
            result.messageLimit = Number(value)
        } else if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        } else if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
        } else {
            throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
        }
    }
    if (result.messageLimit !== undefined && !Number.isFinite(result.messageLimit)) {
        throw new PingPeerError('bad_args', '--limit must be a number')
    }
    return result
}

export async function handleInspectPeerCommand(args: string[]): Promise<void> {
    if (args.length === 1 && args[0] === '--hapi-help-json') {
        printHapiCliCapabilities('inspect-peer')
        return
    }
    const parsed = parseInspectPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }
    await initializeToken()
    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing session id; usage: hapi inspect-peer <session-id>')
    }
    console.log(formatInspectPeerReport(await inspectPeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        messageLimit: parsed.messageLimit
    })))
}

export const inspectPeerCommand: CommandDefinition = {
    name: 'inspect-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handleInspectPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi inspect-peer:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(chalk.red('hapi inspect-peer:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
