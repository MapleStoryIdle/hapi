import { useState } from 'react'
import { DetailCopyButton } from '@/components/ui/DetailCopyButton'
import { useTranslation } from '@/lib/use-translation'
import type { TerminalExecutionDetails, TerminalExecutionState } from './terminalExecution'

/** Log viewer, not a PTY: never executes commands or invents stream ordering. */
export function TerminalTranscript(props: { details: TerminalExecutionDetails; state: TerminalExecutionState }) {
    const { t } = useTranslation()
    const [wrap, setWrap] = useState(false)
    const { command, stdout, stderr } = props.details
    const output = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n')
    const waiting = props.state === 'running' || props.state === 'pending'
    const codeClass = wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
    return <div className="terminal-transcript" data-wrap={wrap}>
        <div className="flex items-center justify-between gap-2">
            <button type="button" className="chat-detail-control" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
                {t('terminal.execution.wrapLines')}
            </button>
            {output ? <DetailCopyButton showLabel value={output} label={t('terminal.execution.copyOutput')} /> : null}
        </div>
        <div className="terminal-transcript-surface divide-y divide-[var(--app-border)]">
            <section data-terminal-execution-input>
                <div className="flex min-h-11 items-center justify-between gap-2 px-3">
                    <h3 className="text-xs font-medium text-[var(--app-hint)]">{t('terminal.execution.command')}</h3>
                    {command ? <DetailCopyButton value={command} label={t('terminal.execution.copyCommand')} /> : null}
                </div>
                {command ? <pre className={`terminal-transcript-code ${codeClass}`}><code>{command}</code></pre>
                    : <p className="px-3 pb-3 text-sm text-[var(--app-hint)]">{t('terminal.execution.commandUnavailable')}</p>}
            </section>
            <section data-terminal-execution-output>
                {stdout ? <div>
                    <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--app-hint)]">stdout</h3>
                    <pre className={`terminal-transcript-code ${codeClass}`}><code>{stdout}</code></pre>
                </div> : null}
                {stderr ? <div>
                    <h3 className={`px-3 pb-1 pt-2 text-xs font-medium ${props.state === 'failed' ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'}`}>stderr</h3>
                    <pre className={`terminal-transcript-code ${codeClass}`}><code>{stderr}</code></pre>
                </div> : null}
                {!stdout && !stderr ? <p className="px-3 py-3 text-sm text-[var(--app-hint)]" role="status">
                    {t(waiting ? 'terminal.execution.outputPending' : 'terminal.execution.noOutput')}
                </p> : null}
            </section>
        </div>
    </div>
}
