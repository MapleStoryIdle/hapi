import { readFile } from 'node:fs/promises'
import chalk from 'chalk'
import { initializeToken } from '@/ui/tokenInit'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    formatPeerSessionsList,
    listPeerSessions,
    peerListFetchLimit,
    pingPeer
} from '@/modules/pingPeer/pingPeer'
import type { CommandDefinition } from './types'
import { printHapiCliCapabilities } from './capabilities'

export type ParsedPingPeerArgs = {
    help: boolean
    list: boolean
    sessionIdPrefix?: string
    message?: string
    messageFile?: string
    waitActiveSecs?: number
}

function showHelp(): void {
    console.log(`
${chalk.bold('hapi ping-peer')} - 唤醒（如需要）并向同一 Hub 的另一个会话发送消息

${chalk.bold('Usage:')}
  hapi ping-peer <session-id-prefix> <message-text>
  hapi ping-peer <session-id-prefix> --message-file <path>
  hapi ping-peer <session-id-prefix> --message-file -
  hapi ping-peer --list

${chalk.bold('Machine-readable contract:')}
  输入是同一 namespace 下唯一的会话 ID 或前缀；输出仅表示投递结果。
  不支持通过参数指定 Hub 主机，始终使用 HAPI_API_URL / 当前登录配置。
  也可传入 [title](/sessions/<id>) 或 Copy-reference 文本；多个引用会拒绝执行。
  从 HAPI Agent 会话内调用时，会拒绝向当前会话自身投递，避免自激循环。

${chalk.bold('Options:')}
  --list                 列出最近活跃会话（只读）
  --message-file <path>  从文件读取消息；- 表示 stdin
  --wait <seconds>       等待被唤醒会话激活的最长时间，默认 60
`)
}

/** 解析 ping-peer 参数；单独导出以便其他 CLI 前端和自动化复用。 */
export function parsePingPeerArgs(args: string[]): ParsedPingPeerArgs {
    const result: ParsedPingPeerArgs = { help: false, list: false }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!
        if (arg === '--help' || arg === '-h') {
            result.help = true
        } else if (arg === '--list') {
            result.list = true
        } else if (arg === '--message-file' || arg.startsWith('--message-file=')) {
            const value = arg === '--message-file' ? args[++i] : arg.slice('--message-file='.length)
            if (!value) throw new PingPeerError('bad_args', '--message-file requires a path (or - for stdin)')
            result.messageFile = value
        } else if (arg === '--wait' || arg.startsWith('--wait=')) {
            const value = arg === '--wait' ? args[++i] : arg.slice('--wait='.length)
            if (!value) throw new PingPeerError('bad_args', '--wait requires seconds')
            result.waitActiveSecs = Number(value)
        } else if (arg.startsWith('-')) {
            throw new PingPeerError('bad_args', `unexpected flag: ${arg}`)
        } else if (!result.sessionIdPrefix) {
            result.sessionIdPrefix = arg
        } else if (result.message === undefined) {
            result.message = arg
        } else {
            throw new PingPeerError('bad_args', `unexpected arg: ${arg}`)
        }
    }
    if (result.waitActiveSecs !== undefined && (!Number.isFinite(result.waitActiveSecs) || result.waitActiveSecs <= 0)) {
        throw new PingPeerError('bad_args', '--wait must be a positive number of seconds')
    }
    if (result.list && (result.sessionIdPrefix || result.message || result.messageFile)) {
        throw new PingPeerError('bad_args', '--list cannot be combined with a target session or message')
    }
    return result
}

async function readMessage(parsed: ParsedPingPeerArgs): Promise<string> {
    if (parsed.messageFile === undefined) return parsed.message ?? ''
    if (parsed.message !== undefined) {
        throw new PingPeerError('bad_args', 'provide a message argument or --message-file, not both')
    }
    if (parsed.messageFile === '-') {
        const chunks: Buffer[] = []
        for await (const chunk of process.stdin) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        return Buffer.concat(chunks).toString('utf8')
    }
    return await readFile(parsed.messageFile, 'utf8')
}

function envWaitActiveSecs(): number | undefined {
    const raw = process.env.HAPI_WAIT_ACTIVE_SECS
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) {
        throw new PingPeerError('bad_args', 'HAPI_WAIT_ACTIVE_SECS must be a positive number')
    }
    return value
}

export async function handlePingPeerCommand(args: string[]): Promise<void> {
    if (args.length === 1 && args[0] === '--hapi-help-json') {
        printHapiCliCapabilities('ping-peer')
        return
    }
    const parsed = parsePingPeerArgs(args)
    if (parsed.help) {
        showHelp()
        return
    }

    await initializeToken()
    if (parsed.list) {
        const maxRows = 30
        const sessions = await listPeerSessions({ limit: peerListFetchLimit(maxRows) })
        console.log(formatPeerSessionsList(sessions, { maxRows, hasMore: sessions.length > maxRows }))
        return
    }

    if (!parsed.sessionIdPrefix) {
        showHelp()
        throw new PingPeerError('bad_args', 'missing session id; usage: hapi ping-peer <session-id> <message>')
    }
    const message = await readMessage(parsed)
    if (!message) {
        throw new PingPeerError('bad_args', 'missing message; provide an argument or --message-file')
    }

    const result = await pingPeer({
        sessionIdPrefix: parsed.sessionIdPrefix,
        message,
        waitActiveSecs: parsed.waitActiveSecs ?? envWaitActiveSecs(),
        onProgress: (line) => console.log(`hapi ping-peer: ${line}`)
    })
    console.log(chalk.green(`hapi ping-peer: OK - delivered to ${result.sessionId}`))
}

export const pingPeerCommand: CommandDefinition = {
    name: 'ping-peer',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            await handlePingPeerCommand(commandArgs)
        } catch (error) {
            if (error instanceof PingPeerError) {
                console.error(chalk.red('hapi ping-peer:'), error.message)
                process.exit(exitCodeForPingPeerError(error))
            }
            console.error(chalk.red('hapi ping-peer:'), error instanceof Error ? error.message : 'Unknown error')
            process.exit(1)
        }
    }
}
