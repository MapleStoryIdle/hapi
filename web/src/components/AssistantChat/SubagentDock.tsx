import { useMemo, useState } from 'react'
import { AGENT_MESSAGE_PAYLOAD_TYPE, isObject, safeStringify } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { CodexSubagentState, DecryptedMessage } from '@/types/api'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const TERMINAL_SUBAGENT_STATUSES = new Set([
    'completed',
    'failed',
    'error',
    'canceled',
    'cancelled',
    'notFound',
    'not_found'
])

type SubagentEvent = {
    id: string
    type: string
    createdAt: number
    status?: string
    activity?: string
    summary?: string
    text?: string
    raw?: unknown
}

function RobotIcon(props: { className?: string }) {
    return (
        <svg className={props.className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <rect x="5" y="7" width="14" height="11" rx="4" stroke="currentColor" strokeWidth="1.8" />
            <path d="M9 12h.01M15 12h.01" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M9.5 15.25h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M3.5 12.5h1.25M19.25 12.5h1.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    )
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const minuteRest = minutes % 60
    return minuteRest > 0 ? `${hours}h ${minuteRest}m` : `${hours}h`
}

export function isCodexSubagentActive(subagent: CodexSubagentState): boolean {
    return !TERMINAL_SUBAGENT_STATUSES.has(subagent.status)
}

export function getSortedCodexSubagents(subagents: Record<string, CodexSubagentState> | null | undefined): CodexSubagentState[] {
    return Object.values(subagents ?? {}).sort((a, b) => {
        const activeDelta = Number(isCodexSubagentActive(b)) - Number(isCodexSubagentActive(a))
        if (activeDelta !== 0) return activeDelta
        return b.updatedAt - a.updatedAt
    })
}

function extractAgentPayload(message: DecryptedMessage): Record<string, unknown> | null {
    const wrapped = unwrapRoleWrappedRecordEnvelope(message.content)
    if (wrapped?.role !== 'agent') return null
    if (!isObject(wrapped.content)) return null
    if (wrapped.content.type !== AGENT_MESSAGE_PAYLOAD_TYPE) return null
    const data = wrapped.content.data
    return isObject(data) ? data : null
}

function getEventAgentId(event: Record<string, unknown>): string | undefined {
    const direct = asString(event.agentId ?? event.agent_id)
    if (direct) return direct
    const scope = isObject(event.scope) ? event.scope : null
    return asString(scope?.agentId ?? scope?.agent_id)
}

function eventMatchesSubagent(event: Record<string, unknown>, subagent: CodexSubagentState): boolean {
    const agentId = getEventAgentId(event)
    if (agentId === subagent.id) return true
    const cardId = asString(event.cardId ?? event.card_id)
    return Boolean(subagent.cardId && cardId === subagent.cardId)
}

function textFromTraceMessage(message: unknown): string | undefined {
    if (typeof message === 'string') return message
    if (!isObject(message)) return undefined
    return asString(message.text)
        ?? asString(message.message)
        ?? asString(message.activity)
        ?? asString(message.statusText ?? message.status_text)
        ?? asString(message.name)
}

function eventText(event: Record<string, unknown>): string | undefined {
    if (event.type === 'agent-run-trace') {
        return textFromTraceMessage(event.message)
    }
    return asString(event.activity)
        ?? asString(event.summary)
        ?? asString(event.statusText ?? event.status_text)
        ?? asString(event.status)
}

export function getSubagentEvents(messages: readonly DecryptedMessage[], subagent: CodexSubagentState): SubagentEvent[] {
    const events: SubagentEvent[] = []
    for (const message of messages) {
        const event = extractAgentPayload(message)
        if (!event) continue
        const type = asString(event.type)
        if (type !== 'agent-run-start' && type !== 'agent-run-update' && type !== 'agent-run-trace') continue
        if (!eventMatchesSubagent(event, subagent)) continue

        events.push({
            id: message.id,
            type,
            createdAt: message.createdAt,
            status: asString(event.status),
            activity: asString(event.activity),
            summary: asString(event.summary),
            text: eventText(event),
            raw: type === 'agent-run-trace' ? event.message : event
        })
    }
    return events
}

function getSubagentTitle(subagent: CodexSubagentState): string {
    return subagent.title ?? subagent.summary ?? subagent.type ?? subagent.id
}

function StatusDot(props: { active: boolean }) {
    return (
        <span
            className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                props.active ? 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.16)]' : 'bg-[var(--app-hint)]/45'
            )}
            aria-hidden="true"
        />
    )
}

function SubagentIconTile(props: { active: boolean }) {
    return (
        <span
            className={cn(
                'relative flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-[15px] border',
                props.active
                    ? 'border-sky-300/70 bg-sky-500/10 text-sky-600 shadow-[0_8px_20px_rgba(14,165,233,0.16)] dark:text-sky-300'
                    : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]'
            )}
            aria-hidden="true"
        >
            {props.active ? (
                <span className="pointer-events-none absolute inset-x-2 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/90 to-transparent" />
            ) : null}
            <RobotIcon className="h-5 w-5" />
            <span className="absolute bottom-1.5 right-1.5">
                <StatusDot active={props.active} />
            </span>
        </span>
    )
}

function SubagentEventRow(props: { event: SubagentEvent }) {
    const label = props.event.type === 'agent-run-trace'
        ? 'trace'
        : props.event.status ?? props.event.type.replace('agent-run-', '')
    const text = props.event.text
    const fallback = text ? null : safeStringify(props.event.raw)

    return (
        <div className="rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-[var(--app-hint)]">
                <span>{label}</span>
                <span>{new Date(props.event.createdAt).toLocaleTimeString()}</span>
            </div>
            {text ? (
                <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-1 prose-pre:my-2 text-sm text-[var(--app-fg)]">
                    <MarkdownRenderer content={text} />
                </div>
            ) : (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--app-fg)]/75">
                    {fallback}
                </pre>
            )}
        </div>
    )
}

function SubagentDrawer(props: {
    subagent: CodexSubagentState
    messages: readonly DecryptedMessage[]
    onClose: () => void
}) {
    const { t } = useTranslation()
    const events = useMemo(() => getSubagentEvents(props.messages, props.subagent), [props.messages, props.subagent])
    const active = isCodexSubagentActive(props.subagent)
    const duration = formatDuration((props.subagent.completedAt ?? Date.now()) - props.subagent.startedAt)

    return (
        <div className="fixed inset-0 z-[80] flex justify-end bg-black/35 backdrop-blur-[2px]" onClick={props.onClose}>
            <aside
                className="flex h-full w-full max-w-[min(28rem,92vw)] flex-col border-l border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
                onClick={(event) => event.stopPropagation()}
                aria-label={t('subagents.drawerTitle')}
            >
                <div className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] px-4 py-4">
                    <div className="min-w-0">
                        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--app-fg)]">
                            <StatusDot active={active} />
                            <span className="truncate">{getSubagentTitle(props.subagent)}</span>
                        </div>
                        <div className="text-xs text-[var(--app-hint)]">
                            {props.subagent.statusText ?? props.subagent.status} · {duration}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        aria-label={t('button.close')}
                    >
                        ×
                    </button>
                </div>
                <div className="flex-1 space-y-3 overflow-y-auto p-4">
                    {events.length > 0 ? (
                        events.map((event, index) => (
                            <SubagentEventRow key={`${event.id}:${index}`} event={event} />
                        ))
                    ) : (
                        <div className="rounded-xl border border-dashed border-[var(--app-border)] p-4 text-sm text-[var(--app-hint)]">
                            {t('subagents.noLoadedEvents')}
                        </div>
                    )}
                </div>
            </aside>
        </div>
    )
}

export function SubagentDock(props: {
    subagents: Record<string, CodexSubagentState> | null | undefined
    messages: readonly DecryptedMessage[]
}) {
    const { t } = useTranslation()
    const [listOpen, setListOpen] = useState(false)
    const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null)
    const subagents = useMemo(() => getSortedCodexSubagents(props.subagents), [props.subagents])
    const activeSubagents = subagents.filter(isCodexSubagentActive)
    const selectedSubagent = selectedSubagentId
        ? subagents.find((subagent) => subagent.id === selectedSubagentId) ?? null
        : null

    if (activeSubagents.length === 0) {
        return null
    }

    return (
        <div className="absolute left-4 top-0 z-30 -translate-y-[calc(100%+0.35rem)]">
            <button
                type="button"
                className="relative isolate flex h-8 items-center gap-1.5 overflow-hidden rounded-full border border-sky-300/55 bg-[var(--app-bg)]/92 px-2.5 text-xs font-semibold text-[var(--app-fg)] shadow-[0_10px_28px_rgba(14,165,233,0.18)] backdrop-blur-xl transition-colors hover:bg-[var(--app-subtle-bg)]"
                aria-label={t('subagents.badgeAria', { count: activeSubagents.length })}
                aria-expanded={listOpen}
                onClick={() => setListOpen((open) => !open)}
            >
                <span className="pointer-events-none absolute inset-x-2 top-0 h-px bg-gradient-to-r from-transparent via-white/95 to-transparent" aria-hidden="true" />
                <span className="pointer-events-none absolute -top-3 left-1/2 h-7 w-16 -translate-x-1/2 rounded-full bg-sky-400/25 blur-md animate-pulse" aria-hidden="true" />
                <RobotIcon className="h-4 w-4" />
                <span>{activeSubagents.length}</span>
            </button>

            {listOpen ? (
                <div className="absolute bottom-[calc(100%+0.4rem)] left-0 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl backdrop-blur-xl">
                    <div className="border-b border-[var(--app-border)] px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                        {t('subagents.title')}
                    </div>
                    <div className="max-h-72 space-y-2 overflow-y-auto p-2">
                        {subagents.map((subagent) => {
                            const active = isCodexSubagentActive(subagent)
                            const duration = formatDuration((subagent.completedAt ?? Date.now()) - subagent.startedAt)
                            return (
                                <button
                                    key={subagent.id}
                                    type="button"
                                    className={cn(
                                        'relative isolate flex w-full items-stretch gap-3 overflow-hidden rounded-[18px] border p-2.5 text-left transition-[border-color,background-color,box-shadow,transform] hover:-translate-y-px',
                                        active
                                            ? 'border-sky-300/60 bg-sky-500/[0.07] shadow-[0_10px_24px_rgba(14,165,233,0.12)]'
                                            : 'border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70 hover:bg-[var(--app-bg)]'
                                    )}
                                    onClick={() => {
                                        setSelectedSubagentId(subagent.id)
                                        setListOpen(false)
                                    }}
                                >
                                    {active ? (
                                        <>
                                            <span className="pointer-events-none absolute inset-x-3 top-0 h-px rounded-full bg-gradient-to-r from-transparent via-white/95 to-transparent" aria-hidden="true" />
                                            <span className="pointer-events-none absolute -top-5 left-1/2 h-9 w-28 -translate-x-1/2 rounded-full bg-sky-400/20 blur-xl animate-pulse" aria-hidden="true" />
                                        </>
                                    ) : null}
                                    <SubagentIconTile active={active} />
                                    <span className="min-w-0 flex-1 self-center">
                                        <span className="block truncate text-sm font-medium text-[var(--app-fg)]">
                                            {getSubagentTitle(subagent)}
                                        </span>
                                        <span className="mt-0.5 block truncate text-xs text-[var(--app-hint)]">
                                            {subagent.activity ?? subagent.statusText ?? subagent.status} · {duration}
                                        </span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                </div>
            ) : null}

            {selectedSubagent ? (
                <SubagentDrawer
                    subagent={selectedSubagent}
                    messages={props.messages}
                    onClose={() => setSelectedSubagentId(null)}
                />
            ) : null}
        </div>
    )
}
