import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { Activity, AlertTriangle, Archive, Clock, Layers2, RefreshCw, WifiOff, type LucideIcon } from 'lucide-react'
import { MESSAGE_LINK_CLASS, MessageLinkIcon } from '@/components/MessageLink'
import { useLocalServiceLink } from '@/lib/local-service-links'
import { getEventPresentation, isForbiddenTaskStatus, isNetworkTaskStatus, isUsageLimitEvent } from '@/chat/presentation'
import type { AgentEvent } from '@/chat/types'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'

type TaskStatusEvent = Extract<AgentEvent, { type: 'task-status' }>
type AutomationHeartbeatEvent = Extract<AgentEvent, { type: 'automation-heartbeat' }>
type CompactEvent = Extract<AgentEvent, { type: 'compact' }>

function isTaskStatusEvent(event: AgentEvent | undefined): event is TaskStatusEvent {
    return event?.type === 'task-status'
}

function isAutomationHeartbeatEvent(event: AgentEvent | undefined): event is AutomationHeartbeatEvent {
    return event?.type === 'automation-heartbeat'
}

function isCompactEvent(event: AgentEvent | undefined): event is CompactEvent {
    return event?.type === 'compact'
}

function taskStatusAttempt(event: TaskStatusEvent): string | null {
    if (typeof event.retryAttempt !== 'number' || typeof event.maxRetries !== 'number') return null
    return `${event.retryAttempt}/${event.maxRetries}`
}

function taskStatusVisual(event: TaskStatusEvent): {
    Icon: LucideIcon
    titleKey: string
    bodyKey: string
    bodyParams?: Record<string, string | number>
    toneClassName: string
    iconClassName: string
    actionKey?: string
} {
    const attempt = taskStatusAttempt(event)

    if (event.status === 'retrying') {
        return {
            Icon: RefreshCw,
            titleKey: 'taskStatus.retrying.title',
            bodyKey: attempt ? 'taskStatus.retrying.bodyWithAttempt' : 'taskStatus.retrying.body',
            bodyParams: attempt ? { attempt } : undefined,
            toneClassName: 'border-[color-mix(in_srgb,#F59E0B_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_90%,#F59E0B)]',
            iconClassName: 'text-amber-600',
        }
    }

    if (event.status === 'compacting') {
        return {
            Icon: Archive,
            titleKey: 'taskStatus.compacting.title',
            bodyKey: attempt ? 'taskStatus.compacting.bodyWithAttempt' : 'taskStatus.compacting.body',
            bodyParams: attempt ? { attempt } : undefined,
            toneClassName: 'border-[color-mix(in_srgb,#3B82F6_38%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_90%,#3B82F6)]',
            iconClassName: 'text-blue-600',
        }
    }

    if (event.status === 'compacted') {
        return {
            Icon: RefreshCw,
            titleKey: 'taskStatus.compacted.title',
            bodyKey: 'taskStatus.compacted.body',
            toneClassName: 'border-[color-mix(in_srgb,#22C55E_36%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_91%,#22C55E)]',
            iconClassName: 'text-green-600',
        }
    }

    if (isForbiddenTaskStatus(event)) {
        return {
            Icon: AlertTriangle,
            titleKey: 'taskStatus.forbidden.title',
            bodyKey: 'taskStatus.forbidden.body',
            toneClassName: 'border-[color-mix(in_srgb,#EF4444_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_91%,#EF4444)]',
            iconClassName: 'text-red-600',
        }
    }

    if (event.code === 'usage_limit') {
        return {
            Icon: Clock,
            titleKey: 'taskStatus.usage.title',
            bodyKey: event.resetAtText ? 'taskStatus.usage.bodyWithReset' : 'taskStatus.usage.body',
            bodyParams: event.resetAtText ? { resetAt: event.resetAtText } : undefined,
            toneClassName: 'border-[color-mix(in_srgb,#EF4444_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_91%,#EF4444)]',
            iconClassName: 'text-red-600',
            actionKey: event.actionUrl ? 'taskStatus.usage.action' : undefined,
        }
    }

    if (event.code === 'model_capacity') {
        return {
            Icon: AlertTriangle,
            titleKey: 'taskStatus.modelCapacity.title',
            bodyKey: 'taskStatus.modelCapacity.body',
            toneClassName: 'border-[color-mix(in_srgb,#F59E0B_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_90%,#F59E0B)]',
            iconClassName: 'text-amber-600',
        }
    }

    if (isNetworkTaskStatus(event)) {
        return {
            Icon: WifiOff,
            titleKey: 'taskStatus.network.title',
            bodyKey: 'taskStatus.network.body',
            toneClassName: 'border-[color-mix(in_srgb,#F59E0B_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_90%,#F59E0B)]',
            iconClassName: 'text-amber-600',
        }
    }

    if (event.code === 'context_window') {
        return {
            Icon: AlertTriangle,
            titleKey: 'taskStatus.contextWindow.title',
            bodyKey: 'taskStatus.contextWindow.body',
            toneClassName: 'border-[color-mix(in_srgb,#EF4444_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_91%,#EF4444)]',
            iconClassName: 'text-red-600',
        }
    }

    return {
        Icon: AlertTriangle,
        titleKey: 'taskStatus.failed.title',
        bodyKey: 'taskStatus.failed.body',
        toneClassName: 'border-[color-mix(in_srgb,#EF4444_42%,var(--app-border))] [background:color-mix(in_srgb,var(--app-bg)_91%,#EF4444)]',
        iconClassName: 'text-red-600',
    }
}

function AutomationHeartbeatCard(props: { event: AutomationHeartbeatEvent; messageId: string }) {
    const { t } = useTranslation()
    const decision = props.event.decision === 'DONT_NOTIFY'
        ? t('automationHeartbeat.dontNotify')
        : props.event.decision ?? null

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(props.messageId)} className="scroll-mt-4 py-1">
            <div className="mx-auto w-full max-w-[min(92%,42rem)] px-2">
                <div className="rounded-xl border border-[color-mix(in_srgb,#64748B_30%,var(--app-border))] bg-[color-mix(in_srgb,var(--app-bg)_92%,#64748B)] px-3 py-2 text-left text-sm shadow-sm">
                    <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-bg)_72%,transparent)] text-slate-500 dark:text-slate-300">
                            <Activity className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-3">
                                <div className="font-medium text-[var(--app-fg)]">{t('automationHeartbeat.title')}</div>
                                <MessageTimestamp className="shrink-0 text-[10px] text-[var(--app-hint)]" />
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--app-hint)]">
                                <span>{props.event.automationId}</span>
                                {decision ? (
                                    <>
                                        <span aria-hidden="true">·</span>
                                        <span>{decision}</span>
                                    </>
                                ) : null}
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-[var(--app-fg)]">{props.event.message}</p>
                        </div>
                    </div>
                </div>
            </div>
        </MessagePrimitive.Root>
    )
}

function TaskStatusCard(props: { event: TaskStatusEvent; messageId: string }) {
    const { t } = useTranslation()
    const localServiceLink = useLocalServiceLink(props.event.actionUrl)
    const visual = taskStatusVisual(props.event)
    const Icon = visual.Icon

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(props.messageId)} className="scroll-mt-4 py-1">
            <div className="mx-auto w-full max-w-[min(92%,42rem)] px-2">
                <div className={`rounded-xl border px-3 py-2 text-left text-sm shadow-sm ${visual.toneClassName}`}>
                    <div className="flex items-start gap-2.5">
                        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-bg)_72%,transparent)] ${visual.iconClassName}`}>
                            <Icon className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-3">
                                <div className="font-medium text-[var(--app-fg)]">
                                    {t(visual.titleKey)}
                                </div>
                                <MessageTimestamp className="shrink-0 text-[10px] text-[var(--app-hint)]" />
                            </div>
                            <p className="mt-0.5 text-xs leading-5 text-[var(--app-hint)]">
                                {t(visual.bodyKey, visual.bodyParams)}
                            </p>
                            {visual.actionKey && props.event.actionUrl ? (
                                <a
                                    href={localServiceLink?.href ?? props.event.actionUrl}
                                    onClick={localServiceLink?.onClick}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className={`${MESSAGE_LINK_CLASS} mt-2`}
                                >
                                    <MessageLinkIcon href={props.event.actionUrl} external />
                                    <span className="message-content-link-label">{t(visual.actionKey)}</span>
                                </a>
                            ) : null}
                        </div>
                    </div>
                </div>
            </div>
        </MessagePrimitive.Root>
    )
}

function ContextCompactedDivider(props: { messageId: string }) {
    const { t } = useTranslation()
    const title = t('contextCompacted.title')
    const detail = t('contextCompacted.detail')

    return (
        <TimelineDivider
            messageId={props.messageId}
            title={title}
            detail={detail}
            Icon={Layers2}
            iconClassName="text-indigo-500 dark:text-indigo-300"
            testId="context-compacted-event"
        />
    )
}

function TimelineDivider(props: {
    messageId: string
    title: string
    detail: string
    Icon: LucideIcon
    iconClassName: string
    testId: string
}) {
    const Icon = props.Icon

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(props.messageId)} className="scroll-mt-4 py-2">
            <div
                className="mx-auto flex w-full max-w-[min(92%,42rem)] items-center gap-2 px-2"
                data-testid={props.testId}
                data-event-style="divider"
                role="status"
                aria-label={`${props.title}. ${props.detail}`}
            >
                <span className="h-px min-w-3 flex-1 bg-[color-mix(in_srgb,var(--app-border)_72%,transparent)]" aria-hidden="true" />
                <span className="inline-flex min-w-0 max-w-[75%] shrink items-center gap-1.5 text-[11px] text-[var(--app-hint)]" title={props.detail}>
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${props.iconClassName}`} aria-hidden="true" />
                    <span className="min-w-0 truncate font-medium text-[var(--app-fg)]">{props.title}</span>
                    <span className="shrink-0" aria-hidden="true">·</span>
                    <MessageTimestamp className="shrink-0 text-[10px]" />
                </span>
                <span className="h-px min-w-3 flex-1 bg-[color-mix(in_srgb,var(--app-border)_72%,transparent)]" aria-hidden="true" />
            </div>
        </MessagePrimitive.Root>
    )
}

function UsageLimitDivider(props: { event: AgentEvent; messageId: string }) {
    const presentation = getEventPresentation(props.event)
    const isWarning = props.event.type === 'limit-warning'
    const isUpdate = props.event.type === 'codex-usage-updated'

    return (
        <TimelineDivider
            messageId={props.messageId}
            title={presentation.text}
            detail={
                props.event.type === 'codex-usage-updated' && typeof props.event.message === 'string'
                    ? props.event.message
                    : presentation.text
            }
            Icon={isWarning ? AlertTriangle : Clock}
            iconClassName={
                isWarning
                    ? 'text-amber-600 dark:text-amber-300'
                    : isUpdate
                        ? 'text-sky-600 dark:text-sky-300'
                        : 'text-red-600 dark:text-red-300'
            }
            testId="usage-limit-event"
        />
    )
}

export function HappySystemMessage() {
    const role = useAssistantState(({ message }) => message.role)
    const messageId = useAssistantState(({ message }) => message.id)
    const text = useAssistantState(({ message }) => {
        if (message.role !== 'system') return ''
        return message.content[0]?.type === 'text' ? message.content[0].text : ''
    })
    const icon = useAssistantState(({ message }) => {
        if (message.role !== 'system') return null
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        const event = custom?.kind === 'event' ? custom.event : undefined
        return event ? getEventPresentation(event).icon : null
    })
    const event = useAssistantState(({ message }) => {
        if (message.role !== 'system') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'event' ? custom.event : undefined
    })

    if (role !== 'system') return null

    if (isTaskStatusEvent(event)) {
        return <TaskStatusCard event={event} messageId={messageId} />
    }

    if (event && isUsageLimitEvent(event)) {
        return <UsageLimitDivider event={event} messageId={messageId} />
    }

    if (isAutomationHeartbeatEvent(event)) {
        return <AutomationHeartbeatCard event={event} messageId={messageId} />
    }

    if (isCompactEvent(event)) {
        return <ContextCompactedDivider messageId={messageId} />
    }

    return (
        <MessagePrimitive.Root id={getConversationMessageAnchorId(messageId)} className="scroll-mt-4 py-1">
            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                <span className="inline-flex items-center gap-1">
                    {icon ? <span aria-hidden="true">{icon}</span> : null}
                    <span>{text}</span>
                    <MessageTimestamp className="text-[10px]" />
                </span>
            </div>
        </MessagePrimitive.Root>
    )
}
