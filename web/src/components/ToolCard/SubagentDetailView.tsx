import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { isObject, safeStringify } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { getInputStringAny } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { getCodexAgentActivity, getCodexAgentFieldRows, getCodexAgentPrompt } from './codexAgents'
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
    const refs = useRef<Array<HTMLButtonElement | null>>([])
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

    function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1
            : event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1 - index : null
        if (next === null) return
        event.preventDefault()
        setTab(TABS[next])
        refs.current[next]?.focus()
    }

    return (
        <div ref={rootRef} className="min-w-0" data-subagent-details>
            <div className="sticky top-0 z-10 bg-[var(--app-dialog-bg)] pb-3">
                <div className="chat-segmented" role="tablist" aria-label={t('subagents.drawerTitle')}>
                    {TABS.map((value, index) => (
                        <button
                            key={value}
                            ref={(element) => { refs.current[index] = element }}
                            type="button"
                            id={`${id}-tab-${value}`}
                            role="tab"
                            aria-selected={tab === value}
                            aria-controls={`${id}-panel-${value}`}
                            tabIndex={tab === value ? 0 : -1}
                            onClick={() => setTab(value)}
                            onKeyDown={(event) => onTabKeyDown(event, index)}
                            className="chat-segment"
                        >{t(`subagents.tab.${value}`)}</button>
                    ))}
                </div>
            </div>
            <div role="tabpanel" id={`${id}-panel-${tab}`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0} className="min-w-0 space-y-4 outline-none">
                {tab === 'activity' ? (
                    <>
                        <section className="chat-sheet-group p-4">
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
                        <dl className="chat-sheet-group divide-y divide-[var(--app-border)] px-4">
                            {rows.map((row) => (
                                <div key={row.label} className="grid grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)] gap-3 py-3 text-sm">
                                    <dt className="text-[var(--app-hint)]">{t(`subagents.field.${row.label}`)}</dt>
                                    <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--app-fg)]">{row.value}</dd>
                                </div>
                            ))}
                            <div className="grid grid-cols-[minmax(5rem,0.35fr)_minmax(0,1fr)] gap-3 py-3 text-sm">
                                <dt className="text-[var(--app-hint)]">{t('subagents.startedAt')}</dt>
                                <dd className="text-[var(--app-fg)]">{new Date(tool.startedAt ?? tool.createdAt).toLocaleString()}</dd>
                            </div>
                        </dl>
                        {prompt ? (
                            <section>
                                <h3 className="mb-2 text-xs font-medium text-[var(--app-hint)]">{t('subagents.task')}</h3>
                                <div className="chat-sheet-group p-4"><MarkdownRenderer standalone content={prompt} /></div>
                            </section>
                        ) : null}
                        <details className="chat-sheet-group p-4">
                            <summary className="min-h-11 cursor-pointer py-3 text-sm text-[var(--app-hint)]">{t('subagents.rawData')}</summary>
                            <pre className="mt-3 whitespace-pre-wrap break-all text-xs text-[var(--app-fg)]">{safeStringify({ input: tool.input, result: tool.result })}</pre>
                        </details>
                    </>
                )}
            </div>
        </div>
    )
}
