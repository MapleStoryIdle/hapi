import { useState } from 'react'
import { WrapText } from 'lucide-react'
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
    return <div className="terminal-transcript terminal-transcript-surface" data-wrap={wrap}>
        <section className="terminal-transcript-section" data-terminal-execution-input>
            <div className="terminal-transcript-toolbar">
                <h3 className="terminal-transcript-label">
                    {t('terminal.execution.command')}
                </h3>
                <div className="flex shrink-0 items-center gap-2">
                    <button type="button" className="chat-detail-control" aria-pressed={wrap}
                        aria-label={t('terminal.execution.wrapLines')} title={t('terminal.execution.wrapLines')}
                        onClick={() => setWrap(!wrap)}>
                        <WrapText className="h-4 w-4" aria-hidden="true" />
                    </button>
                    {command ? <DetailCopyButton iconOnly value={command} label={t('terminal.execution.copyCommand')} /> : null}
                </div>
            </div>
            {command ? <div className="terminal-transcript-command-line">
                <span className="terminal-transcript-prompt" aria-hidden="true">$</span>
                <pre className={`terminal-transcript-code ${codeClass}`}><code>{command}</code></pre>
            </div>
                : <p className="terminal-transcript-empty">{t('terminal.execution.commandUnavailable')}</p>}
        </section>
        <section className="terminal-transcript-section" data-terminal-execution-output>
            <div className="terminal-transcript-toolbar">
                <h3 className="terminal-transcript-label">{t('terminal.execution.output')}</h3>
                {output ? <DetailCopyButton iconOnly value={output} label={t('terminal.execution.copyOutput')} /> : null}
            </div>
            {stdout ? <div>
                <h3 className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--app-hint)]">stdout</h3>
                <pre className={`terminal-transcript-code ${codeClass}`}><code>{stdout}</code></pre>
            </div> : null}
            {stderr ? <div>
                <h3 className={`px-3 pb-1 pt-2 text-xs font-medium ${props.state === 'failed' ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'}`}>stderr</h3>
                <pre className={`terminal-transcript-code ${codeClass}`}><code>{stderr}</code></pre>
            </div> : null}
            {!stdout && !stderr ? <p className="terminal-transcript-empty" role="status">
                {t(waiting ? 'terminal.execution.outputPending' : 'terminal.execution.noOutput')}
            </p> : null}
            {props.details.exitCode !== null ? <div className="terminal-transcript-exit" data-terminal-execution-exit-code>
                <span>{t('terminal.execution.exitCodeLabel')}</span>
                <span className="font-mono tabular-nums">{props.details.exitCode}</span>
            </div> : null}
        </section>
    </div>
}
