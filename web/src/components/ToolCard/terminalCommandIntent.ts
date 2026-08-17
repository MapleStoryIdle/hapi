import { getTerminalCommand, getTerminalReadRequests, type FileReadTarget } from '@/components/ToolCard/fileAccess'
import { getInputStringAny } from '@/lib/toolInputUtils'

export type TerminalCommandIntent =
    | { kind: 'read-request'; targets: FileReadTarget[] }
    | { kind: 'search-files' }
    | { kind: 'inspect-git' }
    | { kind: 'run-tests' }
    | { kind: 'run-checks' }
    | { kind: 'typecheck' }
    | { kind: 'build-project' }
    | { kind: 'browse-files' }

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

/**
 * Classify only terminal intents that are safe to describe from their command
 * text. File reads remain requests: a shell command does not prove access.
 */
export function getTerminalCommandIntent(input: unknown): TerminalCommandIntent | null {
    const readTargets = getTerminalReadRequests(input)
    if (readTargets.length > 0) {
        return { kind: 'read-request', targets: readTargets }
    }

    const command = getTerminalCommand(input)
    if (!command) return null

    const isTest = TEST_COMMAND_RE.test(command)
    const isCheck = CHECK_COMMAND_RE.test(command)
    if (isTest && isCheck) return { kind: 'run-checks' }
    if (isTest) return { kind: 'run-tests' }
    if (isCheck) return { kind: 'typecheck' }
    if (BUILD_COMMAND_RE.test(command)) return { kind: 'build-project' }
    if (SEARCH_COMMAND_RE.test(command)) return { kind: 'search-files' }
    if (GIT_INSPECTION_RE.test(command)) return { kind: 'inspect-git' }

    // `find -delete` and `find -exec` are not browsing operations.
    if (BROWSE_COMMAND_RE.test(command) && !/\bfind\b[^;\n]*(?:-delete|-exec)\b/i.test(command)) {
        return { kind: 'browse-files' }
    }

    return null
}

export function getTerminalCommandIntentTitle(intent: TerminalCommandIntent, t?: Translator): string {
    const key = intent.kind === 'read-request'
        ? 'tool.semanticTitle.readFile'
        : `tool.semanticTitle.${intent.kind}`
    const fallback: Record<TerminalCommandIntent['kind'], string> = {
        'read-request': 'Read file',
        'search-files': 'Search files',
        'inspect-git': 'Inspect Git',
        'run-tests': 'Run tests',
        'run-checks': 'Run checks',
        typecheck: 'Type check',
        'build-project': 'Build project',
        'browse-files': 'Browse files'
    }
    return t ? t(key) : fallback[intent.kind]
}

export function usesTerminalCommandAsLabel(intent: TerminalCommandIntent): boolean {
    return intent.kind !== 'read-request'
}

function summarizeTerminalSegment(segment: string): string | null {
    const command = segment.trim().replace(/\s+/g, ' ')
    if (!command || /^(?:echo|printf|true|:|do|done|then|fi)\b/.test(command) || /^(?:\*\*\*|@@|---|\+\+\+)/.test(command)) return null

    const packageRunner = command.match(/\b(?:bun\s+x|bunx|npx|pnpm\s+exec|yarn\s+dlx)\s+([\w.-]+)/)
    if (packageRunner) return packageRunner[0]

    const packageScript = command.match(/\b(?:bun|npm|pnpm|yarn)(?:\s+run)?\s+([\w:@.-]+)/)
    if (packageScript) return packageScript[0]

    const git = command.match(/\bgit(?:\s+-C\s+\S+)*\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|remote|tag|describe)\b/)
    if (git) return `git ${git[1]}`

    const search = command.match(/\b(rg|grep|git\s+grep|fd|ag|ack|findstr|select-string)\b/i)
    if (search) return search[1]!.toLowerCase()

    const browse = command.match(/\b(find|ls|dir|tree|pwd|which|where)\b(?:\s+([^\s|;&]+))?/i)
    if (browse) {
        const path = browse[2] && !browse[2].startsWith('-') ? ` ${browse[2]}` : ''
        return `${browse[1]!.toLowerCase()}${path}`
    }

    const cat = command.match(/\bcat\s+(?:--\s+)?([^\s|;&]+)/)
    if (cat) {
        const path = cat[1]!.replace(/^['"]|['"]$/g, '')
        const parts = path.split('/').filter(Boolean)
        return `cat ${parts.slice(-2).join('/') || path}`
    }

    if (/\bsed\b/.test(command)) return 'sed -n'

    if (/\bapply_patch\b/.test(command)) return 'apply_patch'

    return null
}

function getTerminalCommandForSummary(input: unknown): string | null {
    const parsed = getTerminalCommand(input)
    if (parsed) return parsed

    const raw = getInputStringAny(input, ['command', 'cmd'])?.trim()
    if (!raw) return null

    // Historical Codex traces can carry malformed nested shell quotes. The
    // display summary may still safely inspect their command text.
    const shell = raw.match(/^(?:\S*\/)?(?:zsh|bash|sh)\s+-lc\s+['"]([\s\S]*)$/)
    return shell?.[1]?.trim() || raw
}

/** Return one or two meaningful commands, never the complete shell script. */
export function getTerminalCommandSummary(input: unknown): string | null {
    const command = getTerminalCommandForSummary(input)
    if (!command) return null

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
