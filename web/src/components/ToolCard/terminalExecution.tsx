import { useLayoutEffect, useRef } from 'react'
import { TerminalTranscript } from './TerminalTranscript'
import type { ToolCallBlock } from '@/chat/types'
import { isObject } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { stripAnsiTerminalSequences } from './AnsiTerminalText'
import { getTerminalCommandForDetail } from './terminalCommandIntent'

const TERMINAL_EXECUTION_TOOL_NAMES = new Set(['Bash', 'CodexBash', 'shell_command', 'run_shell_command'])

export type TerminalExecutionDetails = {
    command: string | null
    cwd: string | null
    stdout: string | null
    stderr: string | null
    exitCode: number | null
    status: string | null
    durationMs: number | null
}

export type TerminalExecutionState = 'pending' | 'running' | 'completed' | 'failed'

const EXEC_OUTPUT_ENVELOPE_KEYS = new Set([
    'chunk_id',
    'exit_code',
    'original_token_count',
    'output',
    'session_id',
    'wall_time_seconds'
])

function unwrapExecOutputEnvelope(value: string | null): string | null {
    if (value === null) return null
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return value

    try {
        const parsed: unknown = JSON.parse(trimmed)
        if (!isObject(parsed) || typeof parsed.output !== 'string') return value
        const keys = Object.keys(parsed)
        return keys.length > 0 && keys.every((key) => EXEC_OUTPUT_ENVELOPE_KEYS.has(key))
            ? parsed.output
            : value
    } catch {
        return value
    }
}

export function formatTerminalOutput(value: string): { text: string; language: 'json' | 'text' } {
    const withoutAnsi = stripAnsiTerminalSequences(value).trim()
    const fenced = withoutAnsi.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)?.[1]?.trim() ?? withoutAnsi
    let candidate = fenced

    // Some command wrappers serialize stdout once more, producing a JSON
    // string whose contents are the actual object. Unwrap at most two layers.
    for (let depth = 0; depth < 3; depth += 1) {
        try {
            const parsed: unknown = JSON.parse(candidate)
            if (parsed !== null && typeof parsed === 'object') {
                return { text: JSON.stringify(parsed, null, 2), language: 'json' }
            }
            if (typeof parsed !== 'string') break
            candidate = parsed.trim()
        } catch {
            break
        }
    }

    // JSON Lines is common for CLI output. Keep record boundaries instead of
    // inventing an array, while making every record readable.
    const lines = fenced.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (lines.length > 1) {
        try {
            const records = lines.map((line) => JSON.parse(line) as unknown)
            if (records.every((record) => record !== null && typeof record === 'object')) {
                return {
                    text: records.map((record) => JSON.stringify(record, null, 2)).join('\n\n'),
                    language: 'json'
                }
            }
        } catch {
            // Ordinary terminal text; preserve it exactly below.
        }
    }

    return { text: value, language: 'text' }
}


export function isTerminalExecutionTool(toolName: string): boolean {
    return TERMINAL_EXECUTION_TOOL_NAMES.has(toolName)
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
    if (!record) return null

    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'string' && value.length > 0) return value
    }

    return null
}

function firstNumber(record: Record<string, unknown> | null, keys: string[]): number | null {
    if (!record) return null

    for (const key of keys) {
        const value = record[key]
        if (typeof value === 'number' && Number.isFinite(value)) return value
    }

    return null
}

function getCommandFromInput(input: unknown): string | null {
    const record = isObject(input) ? input : null
    if (!record) return null

    const command = record.command
    if (Array.isArray(command)) {
        const parts = command.filter((part): part is string => typeof part === 'string' && part.length > 0)
        if (parts.length > 0) return parts.join(' ')
    }

    const commandText = firstString(record, ['command', 'cmd'])
    return commandText ? getTerminalCommandForDetail({ command: commandText }) : null
}

function getLegacyCommandOutput(result: unknown): { stdout: string | null; exitCode: number | null } | null {
    if (typeof result !== 'string') return null

    const exitCode = result.match(/^Exit code:\s*(\d+)/m)?.[1]
    const output = result.match(/^Output:\n([\s\S]*)$/m)?.[1]
    if (!exitCode && output === undefined) return null

    return {
        stdout: output ?? null,
        exitCode: exitCode ? Number.parseInt(exitCode, 10) : null
    }
}

export function getTerminalExecutionDetails(block: ToolCallBlock): TerminalExecutionDetails {
    const input = isObject(block.tool.input) ? block.tool.input : null
    const result = isObject(block.tool.result) ? block.tool.result : null
    const legacy = getLegacyCommandOutput(block.tool.result)
    const startedAt = block.tool.startedAt ?? block.tool.createdAt
    const completedAt = block.tool.completedAt
    const recordedDurationMs = typeof block.tool.durationMs === 'number' && Number.isFinite(block.tool.durationMs)
        ? Math.max(0, block.tool.durationMs)
        : typeof block.durationMs === 'number' && Number.isFinite(block.durationMs)
            ? Math.max(0, block.durationMs)
            : null
    const stdout = firstString(result, ['stdout', 'output']) ?? legacy?.stdout ?? null

    return {
        command: getCommandFromInput(result) ?? getCommandFromInput(block.tool.input),
        cwd: firstString(result, ['cwd', 'workingDirectory', 'working_directory'])
            ?? firstString(input, ['cwd', 'workingDirectory', 'working_directory']),
        stdout: unwrapExecOutputEnvelope(stdout),
        stderr: firstString(result, ['stderr', 'error']),
        exitCode: firstNumber(result, ['exit_code', 'exitCode', 'exitcode']) ?? legacy?.exitCode ?? null,
        status: firstString(result, ['status']),
        durationMs: recordedDurationMs ?? (completedAt !== null && startedAt !== null
            ? Math.max(0, completedAt - startedAt)
            : null)
    }
}

export function getTerminalExecutionState(block: ToolCallBlock, details = getTerminalExecutionDetails(block)): TerminalExecutionState {
    if (block.tool.state === 'pending') return 'pending'
    if (block.tool.state === 'running') return 'running'

    const status = details.status?.trim().toLowerCase()
    if (
        block.tool.state === 'error'
        || details.exitCode !== null && details.exitCode !== 0
        || status === 'error'
        || status === 'failed'
        || status === 'failure'
    ) {
        return 'failed'
    }

    return 'completed'
}

export function getTerminalExecutionToolState(block: ToolCallBlock): ToolCallBlock['tool']['state'] {
    const state = getTerminalExecutionState(block)
    return state === 'failed' ? 'error' : state
}

export function formatTerminalExecutionDuration(durationMs: number | null): string | null {
    if (durationMs === null || !Number.isFinite(durationMs)) return null

    if (durationMs < 60_000) {
        return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
    }

    const totalSeconds = Math.floor(durationMs / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}m ${seconds}s`
}

function terminalStateColorClass(state: TerminalExecutionState): string {
    if (state === 'failed') return 'text-[var(--app-badge-error-text)]'
    if (state === 'completed') return 'text-[var(--app-badge-success-text)]'
    if (state === 'pending') return 'text-[var(--app-badge-warning-text)]'
    return 'text-[var(--app-hint)]'
}

function terminalStateDotClass(state: TerminalExecutionState): string {
    if (state === 'failed') return 'bg-red-500'
    if (state === 'completed') return 'bg-emerald-500'
    if (state === 'pending') return 'bg-amber-500'
    return 'bg-[var(--app-hint)] animate-pulse motion-reduce:animate-none'
}

function terminalStateLabel(
    state: TerminalExecutionState,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    return t(`terminal.execution.${state}`)
}

function terminalOutputFallback(
    state: TerminalExecutionState,
    t: (key: string, params?: Record<string, string | number>) => string
): string {
    return state === 'pending' || state === 'running'
        ? t('terminal.execution.outputPending')
        : t('terminal.execution.noOutput')
}

type TerminalExecutionDetailProps = {
    block: ToolCallBlock
    surface?: 'dialog' | 'drawer'
}

function TerminalExecutionDrawerPanel(props: {
    details: TerminalExecutionDetails
    state: TerminalExecutionState
}) {
    const rootRef = useRef<HTMLDivElement>(null)
    const savedScroll = useRef(0)
    const followOutput = useRef(false)
    useLayoutEffect(() => {
        const root = rootRef.current
        const body = root?.closest<HTMLElement>('[data-chat-drawer-body]')
        if (!root || !body) return
        body.scrollTop = savedScroll.current
        const onScroll = () => {
            savedScroll.current = body.scrollTop
            followOutput.current = body.scrollHeight - body.clientHeight - body.scrollTop <= 32
        }
        onScroll()
        body.addEventListener('scroll', onScroll, { passive: true })
        // Observe only the active panel. Keep reading position unless the user is at the bottom.
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
            if (followOutput.current) body.scrollTop = body.scrollHeight
        })
        observer?.observe(root)
        return () => { body.removeEventListener('scroll', onScroll); observer?.disconnect() }
    }, [])

    useLayoutEffect(() => {
        if (!followOutput.current) return
        const body = rootRef.current?.closest<HTMLElement>('[data-chat-drawer-body]')
        // Update before the browser delivers queued scroll events for the old
        // content height, which would otherwise incorrectly disable following.
        if (body) body.scrollTop = body.scrollHeight
    }, [props.details.command, props.details.stdout, props.details.stderr, props.details.exitCode])

    return (
        <div ref={rootRef} className="relative isolate pb-1" data-terminal-execution-detail data-terminal-execution-panel="transcript">
            <TerminalTranscript details={props.details} state={props.state} />
        </div>
    )
}

export function TerminalExecutionDetail(props: TerminalExecutionDetailProps) {
    const { t } = useTranslation()
    const details = getTerminalExecutionDetails(props.block)
    const state = getTerminalExecutionState(props.block, details)
    const duration = formatTerminalExecutionDuration(details.durationMs)
    const hasOutput = Boolean(details.stdout || details.stderr)
    const stdoutDisplay = details.stdout ? formatTerminalOutput(details.stdout) : null
    const stderrDisplay = details.stderr ? formatTerminalOutput(details.stderr) : null

    if (props.surface === 'drawer') {
        return (
            <TerminalExecutionDrawerPanel
                details={details}
                state={state}
            />
        )
    }

    return (
        <div
            className="mt-3 flex min-h-0 max-h-[calc(75vh-4rem)] flex-col gap-4 overflow-y-auto pb-1 max-sm:mt-0 max-sm:max-h-none max-sm:flex-1 max-sm:px-5 max-sm:pb-[calc(1.25rem+var(--app-safe-area-bottom))] max-sm:pt-4"
            data-terminal-execution-detail
        >
            <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3" data-terminal-execution-overview>
                <div className="grid grid-cols-2 gap-2">
                    <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                        <div className="text-[11px] font-medium text-[var(--app-hint)]">{t('terminal.execution.status')}</div>
                        <div className={cn('mt-1 flex items-center gap-2 text-sm font-medium', terminalStateColorClass(state))}>
                            <span className={cn('h-2 w-2 shrink-0 rounded-full', terminalStateDotClass(state))} aria-hidden="true" />
                            {terminalStateLabel(state, t)}
                        </div>
                    </div>
                    {duration ? (
                        <div className="min-w-0 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                            <div className="text-[11px] font-medium text-[var(--app-hint)]">{t('terminal.execution.duration')}</div>
                            <div className="mt-1 font-mono text-sm font-medium text-[var(--app-fg)]">{duration}</div>
                        </div>
                    ) : null}
                </div>
            </section>

            <section className="flex shrink-0 flex-col gap-2" data-terminal-execution-input>
                <h3 className="text-sm font-semibold text-[var(--app-fg)]">{t('terminal.execution.input')}</h3>
                {details.command ? (
                    <CodeBlock code={details.command} language="bash" title={t('terminal.execution.command')} scrollY maxHeight={280} size="comfortable" />
                ) : (
                    <p className="text-sm text-[var(--app-hint)]">{t('terminal.execution.commandUnavailable')}</p>
                )}
                {details.cwd ? (
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5">
                        <div className="text-xs font-medium text-[var(--app-hint)]">{t('terminal.execution.workingDirectory')}</div>
                        <div className="mt-1 break-all font-mono text-xs leading-5 text-[var(--app-fg)]">{details.cwd}</div>
                    </div>
                ) : null}
            </section>

            <section className="flex shrink-0 flex-col gap-2" data-terminal-execution-output>
                <h3 className="text-sm font-semibold text-[var(--app-fg)]">{t('terminal.execution.output')}</h3>
                {stderrDisplay ? (
                    <CodeBlock code={stderrDisplay.text} language={stderrDisplay.language} title={t('terminal.stderr')} scrollY maxHeight={420} size="comfortable" />
                ) : null}
                {stdoutDisplay ? (
                    <CodeBlock code={stdoutDisplay.text} language={stdoutDisplay.language} title={t('terminal.stdout')} scrollY maxHeight={420} size="comfortable" />
                ) : null}
                {!hasOutput ? (
                    <p className="rounded-xl border border-dashed border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-3 text-sm leading-6 text-[var(--app-hint)]">
                        {terminalOutputFallback(state, t)}
                    </p>
                ) : null}
                {details.exitCode !== null ? (
                    <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5" data-terminal-execution-exit-code>
                        <div className="text-xs font-medium text-[var(--app-hint)]">{t('terminal.execution.exitCodeLabel')}</div>
                        <div className="mt-1 font-mono text-sm font-medium text-[var(--app-fg)]">
                            {t('terminal.execution.exitCode', { code: details.exitCode })}
                        </div>
                    </div>
                ) : null}
            </section>
        </div>
    )
}
