import type { ToolCallBlock } from '@/chat/types'
import { isObject } from '@hapi/protocol'
import { CodeBlock } from '@/components/CodeBlock'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

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

    return firstString(record, ['command', 'cmd'])
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

    return {
        command: firstString(result, ['command', 'cmd']) ?? getCommandFromInput(block.tool.input),
        cwd: firstString(result, ['cwd', 'workingDirectory', 'working_directory'])
            ?? firstString(input, ['cwd', 'workingDirectory', 'working_directory']),
        stdout: firstString(result, ['stdout', 'output']) ?? legacy?.stdout ?? null,
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
    if (state === 'failed') return 'text-red-600'
    if (state === 'completed') return 'text-emerald-600'
    if (state === 'pending') return 'text-amber-600'
    return 'text-[var(--app-hint)]'
}

function terminalStateDotClass(state: TerminalExecutionState): string {
    if (state === 'failed') return 'bg-red-500'
    if (state === 'completed') return 'bg-emerald-500'
    if (state === 'pending') return 'bg-amber-500'
    return 'bg-[var(--app-hint)] animate-pulse'
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

export function TerminalExecutionDetail(props: { block: ToolCallBlock }) {
    const { t } = useTranslation()
    const details = getTerminalExecutionDetails(props.block)
    const state = getTerminalExecutionState(props.block, details)
    const duration = formatTerminalExecutionDuration(details.durationMs)
    const hasOutput = Boolean(details.stdout || details.stderr)

    return (
        <div className="mt-3 flex min-h-0 max-h-[calc(75vh-4rem)] flex-col gap-4 overflow-y-auto pb-1 max-sm:mt-0 max-sm:max-h-none max-sm:flex-1 max-sm:px-5 max-sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:pt-4" data-terminal-execution-detail>
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

            <section className="flex min-h-0 flex-col gap-2" data-terminal-execution-input>
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

            <section className="flex min-h-0 flex-col gap-2" data-terminal-execution-output>
                <h3 className="text-sm font-semibold text-[var(--app-fg)]">{t('terminal.execution.output')}</h3>
                {details.stderr ? (
                    <CodeBlock code={details.stderr} language="text" title={t('terminal.stderr')} scrollY maxHeight={420} size="comfortable" />
                ) : null}
                {details.stdout ? (
                    <CodeBlock code={details.stdout} language="text" title={t('terminal.stdout')} scrollY maxHeight={420} size="comfortable" />
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
