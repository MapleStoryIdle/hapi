import { formatFileLineRange, getTerminalCommand, getTerminalReadRequests, type FileReadTarget } from '@/components/ToolCard/fileAccess'
import { getInputStringAny } from '@/lib/toolInputUtils'

type ServiceOperation = 'inspect' | 'start' | 'stop' | 'restart' | 'reload'

export type TerminalCommandIntent =
    | { kind: 'read-request'; targets: FileReadTarget[] }
    | { kind: 'search-files'; files: string[] }
    | { kind: 'inspect-git' }
    | { kind: 'run-tests' }
    | { kind: 'run-checks' }
    | { kind: 'typecheck' }
    | { kind: 'build-project' }
    | { kind: 'browse-files' }
    | { kind: 'request-url'; method: string | null; host: string | null; path: string | null }
    | {
        kind: 'remote-command'
        executable: string
        host: string | null
        mode: 'connect' | 'execute' | 'transfer'
        action: TerminalCommandIntent | null
        files: string[]
    }
    | { kind: 'inspect-processes' }
    | { kind: 'wait' }
    | { kind: 'query-database'; database: string | null; tables: string[] }
    | { kind: 'inspect-output'; files: string[] }
    | { kind: 'manage-service'; operation: ServiceOperation | null; service: string | null }
    | { kind: 'manage-hapi' }
    | { kind: 'stop-process' }
    | { kind: 'manage-files'; files: string[]; move: { from: string; to: string } | null }
    | { kind: 'format-code' }
    | { kind: 'run-program'; program: string }

type Translator = (key: string, params?: Record<string, string | number>) => string

const COMMAND_START = String.raw`(?:^|[;&\n]\s*)`
const TEST_COMMAND_RE = new RegExp(
    `${COMMAND_START}(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:test(?:[:\\w-]+)?|vitest|jest|playwright)\\b|(?:bun\\s+x|bunx|npx|pnpm\\s+exec|yarn\\s+dlx)\\s+(?:vitest|jest|playwright)\\b|(?:vitest|jest|playwright)\\b)`,
    'i'
)
const CHECK_COMMAND_RE = new RegExp(
    `${COMMAND_START}(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?(?:typecheck|lint(?:[:\\w-]+)?)\\b|tsc\\b[^;\\n]*--noEmit\\b)`,
    'i'
)
const BUILD_COMMAND_RE = new RegExp(
    `${COMMAND_START}(?:(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?build(?:[:\\w-]+)?\\b|(?:vite|next|astro)\\s+build\\b)`,
    'i'
)
const SEARCH_COMMAND_RE = new RegExp(
    `${COMMAND_START}(?:rg|grep|git\\s+grep|fd|ag|ack|findstr|select-string)\\b`,
    'i'
)
const GIT_INSPECTION_RE = new RegExp(
    `${COMMAND_START}git(?:\\s+-C\\s+\\S+)*\\s+(?:status|diff|log|show|branch|rev-parse|ls-files|blame|remote|tag|describe)\\b`,
    'i'
)
const BROWSE_COMMAND_RE = new RegExp(
    `${COMMAND_START}(?:ls|dir|find|tree|pwd|which|where)\\b`,
    'i'
)

const HTTP_COMMANDS = new Set(['curl', 'wget', 'http', 'httpie'])
const REMOTE_COMMANDS = new Set(['ssh', 'scp', 'sftp', 'rsync'])
const PROCESS_INSPECTION_COMMANDS = new Set(['ps', 'pgrep', 'pidof', 'lsof', 'ss', 'netstat'])
const DATABASE_COMMANDS = new Set(['sqlite3', 'mysql', 'psql', 'redis-cli', 'mongosh'])
const OUTPUT_INSPECTION_COMMANDS = new Set(['tail', 'head', 'nl', 'jq', 'wc', 'stat', 'file', 'strings', 'awk'])
const SERVICE_COMMANDS = new Set(['systemctl', 'service', 'launchctl', 'journalctl'])
const STOP_PROCESS_COMMANDS = new Set(['kill', 'pkill', 'killall'])
const FILE_MANAGEMENT_COMMANDS = new Set([
    'mkdir', 'rmdir', 'rm', 'unlink', 'mv', 'cp', 'chmod', 'chown', 'touch', 'mktemp',
    'tar', 'gzip', 'gunzip', 'zip', 'unzip'
])
const FORMAT_COMMANDS = new Set(['gofmt', 'prettier', 'black'])
const SHELL_PREFIX_COMMANDS = new Set(['command', 'exec', 'nohup', 'sudo', 'time'])
const SHELL_NOISE_COMMANDS = new Set([
    ':', 'cd', 'echo', 'export', 'false', 'popd', 'printf', 'pushd', 'set', 'true'
])
const SHELL_CONTROL_WORDS = new Set([
    'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'then', 'until', 'while'
])

type ExecutableToken = {
    executable: string
    normalizedExecutable: string
}

type ShellInvocation = ExecutableToken & {
    executableIndex: number
    tokens: string[]
}

function stripHeredocBodies(command: string): string {
    const visibleLines: string[] = []
    let delimiter: string | null = null

    for (const line of command.split(/\r?\n/)) {
        if (delimiter !== null) {
            if (line.trim() === delimiter) delimiter = null
            continue
        }

        visibleLines.push(line)
        const match = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)
        if (match) delimiter = match[1]!
    }

    return visibleLines.join('\n')
}

function tokenizeShellSegment(segment: string): string[] {
    return segment.match(/(?:[^\s'"\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) ?? []
}

function normalizeExecutableToken(token: string): ExecutableToken | null {
    const unquoted = token.replace(/^['"]|['"]$/g, '')
    const executable = unquoted.split(/[\\/]/).filter(Boolean).pop() ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(executable)) return null

    return {
        executable,
        normalizedExecutable: executable.toLowerCase()
    }
}

function extractShellInvocations(command: string): ShellInvocation[] {
    const invocations: ShellInvocation[] = []
    const segments = stripHeredocBodies(command).split(/(?:&&|\|\||[;|\n])/)

    for (const segment of segments) {
        const tokens = tokenizeShellSegment(segment.trim())
        if (tokens.length === 0) continue
        if (SHELL_CONTROL_WORDS.has(tokens[0]!.toLowerCase())) continue

        let index = 0
        while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1

        let invocation = normalizeExecutableToken(tokens[index] ?? '')
        while (invocation && SHELL_PREFIX_COMMANDS.has(invocation.normalizedExecutable)) {
            index += 1
            while (index < tokens.length && (
                tokens[index]!.startsWith('-')
                || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)
            )) index += 1
            invocation = normalizeExecutableToken(tokens[index] ?? '')
        }

        if (!invocation || SHELL_NOISE_COMMANDS.has(invocation.normalizedExecutable)) continue

        invocations.push({
            ...invocation,
            executableIndex: index,
            tokens
        })
    }

    return invocations
}

function unquoteShellToken(token: string): string {
    const first = token[0]
    const last = token[token.length - 1]
    if (token.length >= 2 && (first === "'" || first === '"') && last === first) {
        return token.slice(1, -1)
    }
    return token
}

function safeFileName(value: string, allowPattern = false): string | null {
    const unquoted = unquoteShellToken(value).trim().replace(/[\\/]+$/, '')
    if (
        !unquoted
        || unquoted === '.'
        || unquoted === '..'
        || unquoted.startsWith('-')
        || /[\r\n`$<>|;&]/.test(unquoted)
        || unquoted.includes('://')
    ) return null

    const name = unquoted.split(/[\\/]/).filter(Boolean).pop() ?? ''
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return null
    if (!allowPattern && /[*?\[\]{}]/.test(name)) return null
    return name
}

function isLikelyFileName(name: string): boolean {
    return name.startsWith('.')
        || name.includes('.')
        || /[*?\[\]]/.test(name)
        || /^(?:Dockerfile|Makefile|README|LICENSE|AGENTS?|CHANGELOG)$/i.test(name)
}

function unique(values: Array<string | null>, limit = 4): string[] {
    return values
        .filter((value): value is string => value !== null)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, limit)
}

function getInvocationArgs(invocation: ShellInvocation): string[] {
    return invocation.tokens.slice(invocation.executableIndex + 1).map(unquoteShellToken)
}

function getSearchFiles(invocation: ShellInvocation): string[] {
    let args = getInvocationArgs(invocation)
    if (invocation.normalizedExecutable === 'git' && args[0] === 'grep') args = args.slice(1)

    const namedPatterns: string[] = []
    const consumed = new Set<number>()
    let hasExplicitPattern = false
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (arg === '-g' || arg === '--glob' || arg === '--iglob' || arg === '--include' || arg === '-name' || arg === '-iname') {
            const name = safeFileName(args[index + 1] ?? '', true)
            if (name) namedPatterns.push(name)
            consumed.add(index)
            consumed.add(index + 1)
            index += 1
            continue
        }
        if (arg === '-e' || arg === '--regexp') {
            hasExplicitPattern = true
            consumed.add(index)
            consumed.add(index + 1)
            index += 1
            continue
        }
        const inline = arg.match(/^(?:--glob|--iglob|--include)=(.+)$/)?.[1]
        const name = inline ? safeFileName(inline, true) : null
        if (name) namedPatterns.push(name)
        if (inline) consumed.add(index)
        if (/^--regexp=/.test(arg)) {
            hasExplicitPattern = true
            consumed.add(index)
        }
    }

    const positional = args
        .map((arg, index) => ({ arg, index }))
        .filter(({ arg, index }) => !consumed.has(index) && !arg.startsWith('-'))
    const pathArgs = invocation.normalizedExecutable === 'fd' || invocation.normalizedExecutable === 'findstr'
        ? positional
        : hasExplicitPattern
            ? positional
            : positional.slice(1)
    const pathNames = pathArgs.map(({ arg }) => {
        const name = safeFileName(arg, true)
        return name && isLikelyFileName(name) ? name : null
    })
    return unique([...namedPatterns, ...pathNames])
}

function getOutputFiles(invocation: ShellInvocation): string[] {
    return unique(getInvocationArgs(invocation).map((arg) => {
        const name = safeFileName(arg)
        return name && isLikelyFileName(name) ? name : null
    }))
}

function getManagedFiles(invocation: ShellInvocation): { files: string[]; move: { from: string; to: string } | null } {
    const executable = invocation.normalizedExecutable
    const args = getInvocationArgs(invocation)

    if (executable === 'find') {
        const names = args.flatMap((arg, index) => (
            arg === '-name' || arg === '-iname' ? [safeFileName(args[index + 1] ?? '', true)] : []
        ))
        return { files: unique(names), move: null }
    }

    const positional = args.filter((arg) => !arg.startsWith('-'))
    let pathArgs = positional
    if (executable === 'chmod' || executable === 'chown') pathArgs = positional.slice(1)
    if (executable === 'tar') {
        const archiveIndex = args.findIndex((arg) => arg === '-f' || arg === '--file')
        pathArgs = archiveIndex >= 0 ? [args[archiveIndex + 1] ?? ''] : positional
    }

    const files = unique(pathArgs.map((arg) => safeFileName(arg, true)))
    if ((executable === 'mv' || executable === 'cp') && files.length >= 2) {
        return {
            files,
            move: { from: files[files.length - 2]!, to: files[files.length - 1]! }
        }
    }
    return { files, move: null }
}

function safeHost(value: string): string | null {
    let host = unquoteShellToken(value).trim()
    if (!host || /[\s`$<>|;&/?#]/.test(host)) return null
    if (host.includes('@')) host = host.slice(host.lastIndexOf('@') + 1)
    if (!host || host.length > 253 || !/^[A-Za-z0-9_.:[\]-]+$/.test(host)) return null
    return host
}

const HTTP_OPTIONS_WITH_VALUE = new Set([
    '-A', '--cert', '--connect-to', '--cookie', '--cookie-jar', '--data', '--data-ascii', '--data-binary',
    '--data-raw', '--data-urlencode', '--form', '--header', '--key', '--output', '--proxy', '--proxy-header',
    '--proxy-user', '--referer', '--request', '--resolve', '--upload-file', '--user', '--user-agent',
    '-b', '-c', '-d', '-e', '-F', '-H', '-o', '-T', '-u', '-X'
])

function getHttpUrl(args: string[]): string | null {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (arg === '--url') {
            const url = args[index + 1]
            return url && /^https?:\/\//i.test(url) ? url : null
        }
        const inlineUrl = arg.match(/^--url=(https?:\/\/.*)$/i)?.[1]
        if (inlineUrl) return inlineUrl
        if (HTTP_OPTIONS_WITH_VALUE.has(arg)) {
            index += 1
            continue
        }
        if (arg.startsWith('-')) continue
        if (/^https?:\/\//i.test(arg)) return arg
    }
    return null
}

function getHttpRequestIntent(invocation: ShellInvocation): Extract<TerminalCommandIntent, { kind: 'request-url' }> {
    const args = getInvocationArgs(invocation)
    let method: string | null = null
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        const explicit = arg === '-X' || arg === '--request' ? args[index + 1] : arg.match(/^--request=(.+)$/)?.[1]
        if (explicit && /^[A-Za-z]{2,12}$/.test(explicit)) method = explicit.toUpperCase()
    }
    if (!method && args.some((arg) => arg === '-I' || arg === '--head')) method = 'HEAD'
    if (!method && args.some((arg) => /^(?:-d|--data(?:-ascii|-binary|-raw|-urlencode)?|--form|-F)$/.test(arg) || /^--data[^=]*=/.test(arg))) method = 'POST'
    if (!method && args.some((arg) => /^(?:-T|--upload-file)$/.test(arg) || /^--upload-file=/.test(arg))) method = 'PUT'
    if (!method) method = 'GET'

    const rawUrl = getHttpUrl(args)
    if (!rawUrl) return { kind: 'request-url', method, host: null, path: null }

    try {
        const url = new URL(rawUrl)
        const host = safeHost(url.host)
        const path = url.pathname !== '/' && url.pathname.length <= 160 ? url.pathname : null
        return { kind: 'request-url', method, host, path }
    } catch {
        return { kind: 'request-url', method, host: null, path: null }
    }
}

function safeServiceName(value: string | undefined): string | null {
    if (!value) return null
    const name = unquoteShellToken(value).replace(/\.service$/i, '')
    return /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,79}$/.test(name) ? name : null
}

function getServiceIntent(invocation: ShellInvocation): Extract<TerminalCommandIntent, { kind: 'manage-service' }> {
    const args = getInvocationArgs(invocation)
    let operation: ServiceOperation | null = null
    let service: string | null = null

    if (invocation.normalizedExecutable === 'systemctl') {
        const actionIndex = args.findIndex((arg) => /^(?:status|is-active|show|start|stop|restart|reload)$/.test(arg))
        const action = actionIndex >= 0 ? args[actionIndex]! : null
        operation = action === 'status' || action === 'is-active' || action === 'show'
            ? 'inspect'
            : action as ServiceOperation | null
        service = actionIndex >= 0 ? safeServiceName(args.slice(actionIndex + 1).find((arg) => !arg.startsWith('-'))) : null
    } else if (invocation.normalizedExecutable === 'service') {
        service = safeServiceName(args.find((arg) => !arg.startsWith('-')))
        const action = args.find((arg) => /^(?:status|start|stop|restart|reload)$/.test(arg))
        operation = action === 'status' ? 'inspect' : action as ServiceOperation | null
    } else if (invocation.normalizedExecutable === 'journalctl') {
        const unitIndex = args.findIndex((arg) => arg === '-u' || arg === '--unit')
        service = unitIndex >= 0 ? safeServiceName(args[unitIndex + 1]) : null
        operation = 'inspect'
    }

    return { kind: 'manage-service', operation, service }
}

function safeSqlIdentifier(value: string): string | null {
    const parts = value.split('.').map((part) => part.trim().replace(/^([`"\[])(.*)[`"\]]$/, '$2'))
    if (parts.length === 0 || parts.length > 3) return null
    if (parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$-]{0,63}$/.test(part))) return null
    return parts.join('.')
}

function stripSqlValues(sql: string): string {
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\r\n]*/g, ' ')
        .replace(/'(?:''|\\.|[^'])*'/g, ' ')
        .replace(/"(?:""|\\.|[^"])*"/g, ' ')
}

function getDatabaseIntent(invocation: ShellInvocation): Extract<TerminalCommandIntent, { kind: 'query-database' }> {
    const args = getInvocationArgs(invocation)
    let database: string | null = null
    const databaseFlags = new Set(['-d', '-D', '--database', '--dbname', '--db'])
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (databaseFlags.has(arg)) {
            database = safeSqlIdentifier(args[index + 1] ?? '')
            break
        }
        const inline = arg.match(/^--(?:database|dbname|db)=(.+)$/)?.[1]
        if (inline) {
            database = safeSqlIdentifier(inline)
            break
        }
    }

    if (!database && invocation.normalizedExecutable === 'sqlite3') {
        const path = args.find((arg) => !arg.startsWith('-'))
        database = path ? safeFileName(path) : null
    }

    const sql = stripSqlValues(args.filter((arg) => /\b(?:select|insert|update|delete|with|create|alter|drop)\b/i.test(arg)).join(' '))
    const identifierPattern = String.raw`(?:[A-Za-z_][A-Za-z0-9_$-]*|\`[^\`]+\`|\[[^\]]+\])(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_$-]*|\`[^\`]+\`|\[[^\]]+\]))?`
    const tablePattern = new RegExp(String.raw`\b(?:from|join|update|into|table)\s+(${identifierPattern})`, 'gi')
    const tables: string[] = []
    for (const match of sql.matchAll(tablePattern)) {
        const identifier = safeSqlIdentifier((match[1] ?? '').replace(/\s+/g, ''))
        if (identifier && !tables.includes(identifier)) tables.push(identifier)
    }

    const useDatabase = sql.match(new RegExp(String.raw`\buse\s+(${identifierPattern})`, 'i'))?.[1]
    if (!database && useDatabase) database = safeSqlIdentifier(useDatabase.replace(/\s+/g, ''))
    return { kind: 'query-database', database, tables: tables.slice(0, 4) }
}

const SSH_OPTIONS_WITH_VALUE = new Set([
    '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-P', '-Q', '-R', '-S', '-W', '-w'
])
const TRANSFER_OPTIONS_WITH_VALUE = new Set([
    ...SSH_OPTIONS_WITH_VALUE,
    '--exclude', '--filter', '--include', '--password-file', '--rsync-path', '--rsh'
])

function getSshHost(args: string[]): { host: string | null; hostIndex: number; port: string | null } {
    let port: string | null = null
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (arg === '--') {
            return { host: safeHost(args[index + 1] ?? ''), hostIndex: index + 1, port }
        }
        if (arg === '-p') {
            const value = args[index + 1]
            port = value && /^\d{1,5}$/.test(value) ? value : null
            index += 1
            continue
        }
        const inlinePort = arg.match(/^-p(\d{1,5})$/)?.[1]
        if (inlinePort) {
            port = inlinePort
            continue
        }
        if (SSH_OPTIONS_WITH_VALUE.has(arg)) {
            index += 1
            continue
        }
        if (arg.startsWith('-')) continue

        const host = safeHost(arg)
        if (!host) return { host: null, hostIndex: index, port }
        const withPort = port ? `${host}:${port}` : host
        return { host: withPort, hostIndex: index, port }
    }
    return { host: null, hostIndex: -1, port }
}

function getRemoteSpec(value: string): { host: string; path: string } | null {
    const token = unquoteShellToken(value)
    const match = token.match(/^(?:([^@/:]+)@)?([^/:]+):(.+)$/)
    if (!match) return null
    const host = safeHost(match[2] ?? '')
    if (!host) return null
    return { host, path: match[3] ?? '' }
}

function getTransferOperands(args: string[]): string[] {
    const operands: string[] = []
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!
        if (arg === '--') {
            operands.push(...args.slice(index + 1))
            break
        }
        if (TRANSFER_OPTIONS_WITH_VALUE.has(arg)) {
            index += 1
            continue
        }
        if (/^--(?:exclude|filter|include|password-file|rsync-path|rsh)=/.test(arg)) continue
        if (arg.startsWith('-')) continue
        operands.push(arg)
    }
    return operands
}

function getRemoteIntent(invocation: ShellInvocation): Extract<TerminalCommandIntent, { kind: 'remote-command' }> {
    const args = getInvocationArgs(invocation)
    if (invocation.normalizedExecutable === 'ssh') {
        const target = getSshHost(args)
        const remoteCommand = target.hostIndex >= 0 ? args.slice(target.hostIndex + 1).join(' ').trim() : ''
        const action = remoteCommand ? getTerminalCommandIntent({ command: remoteCommand }) : null
        return {
            kind: 'remote-command',
            executable: invocation.normalizedExecutable,
            host: target.host,
            mode: remoteCommand ? 'execute' : 'connect',
            action: action?.kind === 'remote-command' ? null : action,
            files: []
        }
    }

    const operands = getTransferOperands(args)
    const remote = operands.map(getRemoteSpec).find((value): value is { host: string; path: string } => value !== null) ?? null
    const files = unique(operands.map((arg) => {
        const spec = getRemoteSpec(arg)
        return safeFileName(spec?.path ?? arg, true)
    }))
    return {
        kind: 'remote-command',
        executable: invocation.normalizedExecutable,
        host: remote?.host ?? (invocation.normalizedExecutable === 'sftp' ? safeHost(operands[0] ?? '') : null),
        mode: 'transfer',
        action: null,
        files
    }
}

function friendlyProgramName(invocation: ShellInvocation): string {
    if (/^python(?:\d+(?:\.\d+)*)?$/.test(invocation.normalizedExecutable)) return 'Python'
    if (invocation.normalizedExecutable === 'node') return 'Node.js'
    if (invocation.normalizedExecutable === 'ruby') return 'Ruby'
    if (invocation.normalizedExecutable === 'swift') return 'Swift'
    if (invocation.normalizedExecutable === 'mvn' || invocation.normalizedExecutable === 'mvnw') return 'Maven'
    if (invocation.normalizedExecutable === 'codex') return 'Codex'
    if (invocation.normalizedExecutable === 'ov') return 'OpenViking'
    return invocation.executable
}

function classifyShellInvocation(command: string): TerminalCommandIntent | null {
    const invocation = extractShellInvocations(command)[0]
    if (!invocation) return null

    const executable = invocation.normalizedExecutable
    if (HTTP_COMMANDS.has(executable)) return getHttpRequestIntent(invocation)
    if (REMOTE_COMMANDS.has(executable)) return getRemoteIntent(invocation)
    if (PROCESS_INSPECTION_COMMANDS.has(executable)) return { kind: 'inspect-processes' }
    if (executable === 'sleep') return { kind: 'wait' }
    if (DATABASE_COMMANDS.has(executable) || executable.endsWith('dbcli')) return getDatabaseIntent(invocation)
    if (OUTPUT_INSPECTION_COMMANDS.has(executable)) return { kind: 'inspect-output', files: getOutputFiles(invocation) }
    if (SERVICE_COMMANDS.has(executable)) return getServiceIntent(invocation)
    if (
        executable === 'hapi'
        || executable === 'shapi'
        || (executable.includes('hapi') && executable.endsWith('.sh'))
    ) return { kind: 'manage-hapi' }
    if (STOP_PROCESS_COMMANDS.has(executable)) return { kind: 'stop-process' }
    if (FILE_MANAGEMENT_COMMANDS.has(executable)) return { kind: 'manage-files', ...getManagedFiles(invocation) }
    if (FORMAT_COMMANDS.has(executable)) return { kind: 'format-code' }

    return { kind: 'run-program', program: friendlyProgramName(invocation) }
}

/**
 * Classify only terminal intents that are safe to describe from their command
 * text. File reads remain requests: a shell command does not prove access.
 */
export function getTerminalCommandIntent(input: unknown): TerminalCommandIntent | null {
    const readTargets = getTerminalReadRequests(input)
    if (readTargets.length > 0) {
        return { kind: 'read-request', targets: readTargets }
    }

    const rawCommand = getTerminalCommandForSummary(input)
    if (!rawCommand) return null
    const command = stripHeredocBodies(rawCommand)

    const isTest = TEST_COMMAND_RE.test(command)
    const isCheck = CHECK_COMMAND_RE.test(command)
    if (isTest && isCheck) return { kind: 'run-checks' }
    if (isTest) return { kind: 'run-tests' }
    if (isCheck) return { kind: 'typecheck' }
    if (BUILD_COMMAND_RE.test(command)) return { kind: 'build-project' }
    if (SEARCH_COMMAND_RE.test(command)) {
        const invocation = extractShellInvocations(command)[0]
        return { kind: 'search-files', files: invocation ? getSearchFiles(invocation) : [] }
    }
    if (GIT_INSPECTION_RE.test(command)) return { kind: 'inspect-git' }

    // `find -delete` and `find -exec` are not browsing operations.
    if (BROWSE_COMMAND_RE.test(command) && !/\bfind\b[^;\n]*(?:-delete|-exec)\b/i.test(command)) {
        return { kind: 'browse-files' }
    }

    if (/\bfind\b[^;\n]*(?:-delete|-exec)\b/i.test(command)) {
        const invocation = extractShellInvocations(command).find((item) => item.normalizedExecutable === 'find')
        return { kind: 'manage-files', ...(invocation ? getManagedFiles(invocation) : { files: [], move: null }) }
    }
    const invocationIntent = classifyShellInvocation(command)
    if (invocationIntent && invocationIntent.kind !== 'run-program') return invocationIntent
    if (getTerminalCommandSummary(input)) return null
    return invocationIntent
}

export function getTerminalCommandIntentTitle(intent: TerminalCommandIntent, t?: Translator): string {
    if (intent.kind === 'run-program') {
        return t
            ? t('tool.semanticTitle.runProgram', { program: intent.program })
            : `Run ${intent.program}`
    }

    if (intent.kind === 'request-url') {
        return intent.method ?? (t ? t('tool.semanticTitle.request-url') : 'Request URL')
    }

    if (intent.kind === 'remote-command') {
        return intent.executable
    }

    if (intent.kind === 'manage-service' && intent.operation) {
        const service = intent.service
        const fallback: Record<ServiceOperation, string> = {
            inspect: service ? `Inspect ${service} service` : 'Inspect service',
            start: service ? `Start ${service} service` : 'Start service',
            stop: service ? `Stop ${service} service` : 'Stop service',
            restart: service ? `Restart ${service} service` : 'Restart service',
            reload: service ? `Reload ${service} service` : 'Reload service'
        }
        return t
            ? service
                ? t(`tool.semanticTitle.service.${intent.operation}`, { service })
                : t(`tool.semanticTitle.service.${intent.operation}Generic`)
            : fallback[intent.operation]
    }

    const key = intent.kind === 'read-request'
        ? 'tool.semanticTitle.readFile'
        : `tool.semanticTitle.${intent.kind}`
    const fallback: Record<Exclude<TerminalCommandIntent['kind'], 'run-program'>, string> = {
        'read-request': 'Read file',
        'search-files': 'Search files',
        'inspect-git': 'Inspect Git',
        'run-tests': 'Run tests',
        'run-checks': 'Run checks',
        typecheck: 'Type check',
        'build-project': 'Build project',
        'browse-files': 'Browse files',
        'request-url': 'Request URL',
        'remote-command': 'Connect remotely',
        'inspect-processes': 'Inspect processes',
        wait: 'Wait',
        'query-database': 'Execute SQL',
        'inspect-output': 'Inspect output',
        'manage-service': 'Manage service',
        'manage-hapi': 'Manage SHAPI',
        'stop-process': 'Stop process',
        'manage-files': 'Manage files',
        'format-code': 'Format code'
    }
    return t ? t(key) : fallback[intent.kind]
}

export function usesTerminalCommandAsLabel(intent: TerminalCommandIntent): boolean {
    return intent.kind === 'inspect-git'
        || intent.kind === 'run-tests'
        || intent.kind === 'run-checks'
        || intent.kind === 'typecheck'
        || intent.kind === 'build-project'
        || intent.kind === 'browse-files'
}

function formatNames(names: string[]): string | null {
    if (names.length === 0) return null
    const visible = names.slice(0, 2)
    const remaining = names.length - visible.length
    return remaining > 0 ? `${visible.join(' · ')} · +${remaining}` : visible.join(' · ')
}

function formatDatabaseDetail(intent: Extract<TerminalCommandIntent, { kind: 'query-database' }>): string | null {
    if (intent.tables.length === 0) return intent.database
    const database = intent.database
    if (!database) return formatNames(intent.tables)

    const tableNames = intent.tables.map((table) => (
        table.startsWith(`${database}.`) ? table.slice(database.length + 1) : table
    ))
    if (tableNames.length === 1) return `${database}.${tableNames[0]}`
    const visible = tableNames.slice(0, 2)
    const remaining = tableNames.length - visible.length
    return `${database} · ${visible.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`
}

export function getTerminalCommandIntentDetail(intent: TerminalCommandIntent): string | null {
    if (intent.kind === 'read-request') {
        return formatNames(intent.targets.map((target) => {
            const name = safeFileName(target.path, true)
            if (!name) return ''
            const range = formatFileLineRange(target.lineRange)
            return range ? `${name} · ${range}` : name
        }).filter(Boolean))
    }
    if (intent.kind === 'search-files') return formatNames(intent.files)
    if (intent.kind === 'request-url') {
        if (!intent.host) return null
        return `${intent.host}${intent.path ?? ''}`
    }
    if (intent.kind === 'remote-command') return intent.host
    if (intent.kind === 'query-database') return formatDatabaseDetail(intent)
    if (intent.kind === 'inspect-output') return formatNames(intent.files)
    if (intent.kind === 'manage-files') {
        if (intent.move) return `${intent.move.from} → ${intent.move.to}`
        return formatNames(intent.files)
    }
    return null
}

function summarizeTerminalSegment(segment: string): string | null {
    const command = segment.trim().replace(/\s+/g, ' ')
    if (!command || /^(?:echo|printf|true|:|do|done|then|fi)\b/.test(command) || /^(?:\*\*\*|@@|---|\+\+\+)/.test(command)) return null

    const packageRunner = command.match(/\b(?:bun\s+x|bunx|npx|pnpm\s+exec|yarn\s+dlx)\s+([\w.-]+)/)
    if (packageRunner) return packageRunner[0]

    const packageScript = command.match(/\b(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([\w:@.-]+)/)
    if (packageScript) return packageScript[0]

    const git = command.match(/\bgit(?:\s+-C\s+\S+)*\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote|tag|describe|add|commit|push|pull|fetch|merge|rebase|switch|checkout|restore|reset|stash|cherry-pick|config|check-ignore)\b/)
    if (git) return `git ${git[1]}`

    const search = command.match(/\b(rg|grep|git\s+grep|fd|ag|ack|findstr|select-string)\b/i)
    if (search) return search[1]!.toLowerCase()

    const browse = command.match(/\b(find|ls|dir|tree|pwd|which|where)\b(?:\s+([^\s|;&]+))?/i)
    if (browse) {
        if (browse[1]?.toLowerCase() === 'find' && /\bfind\b[^;\n]*(?:-delete|-exec)\b/i.test(command)) return null
        const path = browse[2] && !browse[2].startsWith('-') ? ` ${browse[2]}` : ''
        return `${browse[1]!.toLowerCase()}${path}`
    }

    const cat = command.match(/\bcat\s+(?:--\s+)?([^\s|;&<>]+)/)
    if (cat) {
        const path = cat[1]!.replace(/^['"]|['"]$/g, '')
        const parts = path.split('/').filter(Boolean)
        return `cat ${parts.slice(-2).join('/') || path}`
    }

    if (/\bsed\b/.test(command)) return 'sed -n'

    if (/\bapply_patch\b/.test(command)) return 'apply_patch'

    return null
}

function decodeJsStringLiteral(literal: string): string | null {
    if (literal.startsWith('"')) {
        try {
            const parsed = JSON.parse(literal)
            return typeof parsed === 'string' ? parsed : null
        } catch {
            return null
        }
    }
    if (!literal.startsWith("'") || !literal.endsWith("'")) return null

    return literal
        .slice(1, -1)
        .replace(/\\(['\\])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
}

/**
 * Codex Desktop records its orchestration wrapper as one `exec` tool call.
 * Recover only literal nested terminal commands; never show the surrounding
 * JavaScript or its arguments in the compact activity list.
 */
function getOrchestratedTerminalCommands(raw: string): string[] {
    if (!/\btools\.exec_command\s*\(/.test(raw)) return []

    const commands: string[] = []
    const fieldPattern = /(?:\bcmd\b|["']cmd["'])\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g
    for (const match of raw.matchAll(fieldPattern)) {
        const command = decodeJsStringLiteral(match[1]!)?.trim()
        if (!command || commands.includes(command)) continue
        commands.push(command)
    }
    return commands
}

function getCodexOrchestrationTitle(input: unknown, t?: Translator): string | null {
    const raw = getTerminalCommand(input) ?? getInputStringAny(input, ['command', 'cmd'])?.trim()
    if (!raw) return null

    const commands = getOrchestratedTerminalCommands(raw)
    if (commands.length === 1) {
        return getTerminalCommandDisplayTitle({ command: commands[0] }, t)
    }
    if (commands.length > 1) {
        return getTerminalCommandSummary({ command: commands.join('\n') })
    }

    const isExecCommand = /\btools\.exec_command\s*\(/.test(raw)
    const isCodexOrchestration = /\btools\.[A-Za-z_$][\w$]*\s*\(/.test(raw)
        || /\bALL_TOOLS\b/.test(raw)
    if (!isCodexOrchestration) return null

    const titleMatches = [...raw.matchAll(/\btitle\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)]
    const explicitTitle = decodeJsStringLiteral(titleMatches[titleMatches.length - 1]?.[1] ?? '')
        ?.replace(/\s+/g, ' ')
        .trim()
    if (explicitTitle) {
        return explicitTitle.length > 96 ? `${explicitTitle.slice(0, 95)}…` : explicitTitle
    }

    if (isExecCommand) {
        return t ? t('terminal.execution.execCommandFallback') : 'Run tool command'
    }
    return t ? t('terminal.execution.toolAction') : 'Tool operation'
}

function getTerminalCommandForSummary(input: unknown): string | null {
    const raw = getTerminalCommand(input) ?? getInputStringAny(input, ['command', 'cmd'])?.trim()
    if (!raw) return null

    const orchestratedCommands = getOrchestratedTerminalCommands(raw)
    if (orchestratedCommands.length > 0) {
        return orchestratedCommands.join('\n')
    }

    // Historical Codex traces can carry malformed nested shell quotes. The
    // display summary may still safely inspect their command text.
    const shell = raw.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)$/)
    if (!shell) return raw

    const quote = shell[1]!
    const payload = shell[2]!.trim()
    return (payload.endsWith(quote) ? payload.slice(0, -1) : payload).trim() || raw
}

/** Return one or two meaningful commands, never the complete shell script. */
export function getTerminalCommandSummary(input: unknown): string | null {
    const rawCommand = getTerminalCommandForSummary(input)
    if (!rawCommand) return null
    const command = stripHeredocBodies(rawCommand)

    const summaries = command
        .split(/(?:&&|\|\||;|\r?\n)/)
        .map(summarizeTerminalSegment)
        .filter((summary): summary is string => summary !== null)
        .filter((summary, index, values) => values.indexOf(summary) === index)

    if (summaries.length === 0) return null
    const visible = summaries.slice(0, 2)
    const remaining = summaries.length - visible.length
    return remaining > 0 ? `${visible.join(' · ')} · +${remaining}` : visible.join(' · ')
}

export function getTerminalCommandIntentLabel(
    input: unknown,
    intent: TerminalCommandIntent,
    t?: Translator
): string {
    const commandSummary = getTerminalCommandSummary(input)
    if (commandSummary && usesTerminalCommandAsLabel(intent)) return commandSummary
    return getTerminalCommandIntentTitle(intent, t)
}

export function getTerminalCommandDisplayTitle(input: unknown, t?: Translator): string | null {
    const orchestrationTitle = getCodexOrchestrationTitle(input, t)
    if (orchestrationTitle) return orchestrationTitle

    const intent = getTerminalCommandIntent(input)
    if (intent) {
        const title = getTerminalCommandIntentLabel(input, intent, t)
        const detail = getTerminalCommandIntentDetail(intent)
        return detail ? `${title} · ${detail}` : title
    }
    return getTerminalCommandSummary(input)
}
