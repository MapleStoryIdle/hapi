import { useId, useLayoutEffect, useRef, useState } from 'react'
import { isObject, safeStringify } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { ChatDetailTabs } from '@/components/ui/ChatDetailTabs'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { getCodexAgentActivity, getCodexAgentFieldRows, getCodexAgentPrompt } from './codexAgents'
import { DetailCopyButton } from '@/components/ui/DetailCopyButton'
import { TraceSection } from './trace'
import { extractTextFromResult } from './views/_results'

const TABS = ['activity', 'information'] as const
type Tab = typeof TABS[number]

/** Detail content only: the surrounding shared drawer owns height and scrolling. */
export function SubagentDetailView(props: { block: ToolCallBlock; metadata: SessionMetadataSummary | null }) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<Tab>('activity')
    const id = useId()
    const rootRef = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        const body = rootRef.current?.closest('[data-chat-drawer-body]')
        if (body) body.scrollTop = 0
    }, [tab])
    const { tool } = props.block
    const activity = getCodexAgentActivity(tool.input)
    const prompt = getCodexAgentPrompt(tool.input)
    const resultText = extractTextFromResult(tool.result)
    const fields = getCodexAgentFieldRows(tool.name, tool.input)
    const rows = fields.filter((row) => row.label !== 'Status' && row.label !== 'Work'
        && !(row.label === 'Target' && fields.some((field) => field.label === 'Agent' && field.value === row.value)))
    const config = isObject(tool.input) && isObject(tool.input.hapiSubagentConfig) ? tool.input.hapiSubagentConfig : null
    if (!rows.some((row) => row.label === 'Model')) {
        const model = getInputStringAny(config, ['childModel', 'child_model', 'parentModel', 'parent_model']) ?? props.block.model
        if (model) rows.push({ label: 'Model', value: model })
    }
    if (!rows.some((row) => row.label === 'Reasoning')) {
        const effort = getInputStringAny(config, ['childReasoningEffort', 'child_reasoning_effort', 'parentReasoningEffort', 'parent_reasoning_effort'])
        if (effort) rows.push({ label: 'Reasoning', value: effort })
    }
    const stateClass = tool.state === 'error'
        ? 'bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]'
        : tool.state === 'completed'
            ? 'bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]'
            : 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'

    return (
        <div ref={rootRef} className="min-w-0" data-subagent-details>
            <div className="sticky top-0 z-10 bg-[var(--app-dialog-bg)] pb-2">
                <ChatDetailTabs tabs={TABS.map((value) => ({ value, label: t(`subagents.tab.${value}`) }))}
                    value={tab} onChange={setTab} idPrefix={id} label={t('subagents.drawerTitle')} />
            </div>
            <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="min-w-0 space-y-3 outline-none">
                {tab === 'activity' ? (
                    <>
                        <section className="px-1 py-1">
                            <span className={cn('inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold', stateClass)} role="status">
                                <span className={cn('h-1.5 w-1.5 rounded-full bg-current', tool.state === 'running' && 'motion-safe:animate-pulse')} aria-hidden="true" />
                                {t(`subagents.state.${tool.state}`)}
                            </span>
                            {activity ? <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--app-fg)]">{activity}</p> : null}
                        </section>
                        <TraceSection block={props.block} metadata={props.metadata} layout="drawer" />
                        {resultText ? (
                            <section className="min-w-0 rounded-2xl bg-[var(--app-subtle-bg)] p-3">
                                <h3 className="mb-2 text-xs font-medium text-[var(--app-hint)]">{t('tool.result')}</h3>
                                <MarkdownRenderer standalone content={resultText} />
                            </section>
                        ) : null}
                        {!props.block.children.length && !resultText ? (
                            <p className="chat-sheet-feedback">{t('subagents.noLoadedEvents')}</p>
                        ) : null}
                    </>
                ) : (
                    <>
                        <dl className="chat-sheet-group divide-y divide-[var(--app-border)] px-3">
                            {rows.map((row) => (
                                <div key={row.label} className="grid grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)] gap-3 py-2 text-sm">
                                    <dt className="text-[var(--app-hint)]">{t(`subagents.field.${row.label}`)}</dt>
                                    <dd className="flex min-w-0 items-start gap-1 text-[var(--app-fg)]"><span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.value}</span>{row.value.length > 32 ? <DetailCopyButton value={row.value} label={`${t('code.copy')} ${t(`subagents.field.${row.label}`)}`} /> : null}</dd>
                                </div>
                            ))}
                            <div className="grid grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)] gap-3 py-2 text-sm">
                                <dt className="text-[var(--app-hint)]">{t('subagents.startedAt')}</dt>
                                <dd className="text-[var(--app-fg)]">{new Date(tool.startedAt ?? tool.createdAt).toLocaleString()}</dd>
                            </div>
                        </dl>
                        {prompt ? (
                            <section>
                                <h3 className="mb-2 text-xs font-medium text-[var(--app-hint)]">{t('subagents.task')}</h3>
                                <div className="chat-sheet-group p-3"><MarkdownRenderer standalone content={prompt} /></div>
                            </section>
                        ) : null}
                        <details className="chat-sheet-group p-3">
                            <summary className="min-h-11 cursor-pointer py-2.5 text-sm text-[var(--app-hint)]">{t('subagents.rawData')}</summary>
                            <pre className="mt-2 whitespace-pre-wrap break-all text-xs text-[var(--app-fg)]">{safeStringify({ input: tool.input, result: tool.result })}</pre>
                        </details>
                    </>
                )}
            </div>
        </div>
    )
}
