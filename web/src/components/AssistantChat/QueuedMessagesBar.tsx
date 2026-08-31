import * as Dialog from '@radix-ui/react-dialog'
import { useAssistantApi } from '@assistant-ui/react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { isQueuedForInvocation } from '@/lib/messages'
import { EMPTY_STATE } from '@/hooks/queries/useMessages'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import type { DecryptedMessage } from '@/types/api'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { formatScheduledTime } from '@/lib/scheduledTime'
import { CloseIcon, ScheduleIcon } from '@/components/icons'
import { QueueIcon, SessionDetailQueueTrigger } from '@/components/SessionDetailQueueTrigger'

function EditIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
        </svg>
    )
}

/**
 * Orders queued messages so the drawer reads top-down as a single timeline:
 *   1. Immediate-queued messages first, in the order they were submitted.
 *   2. Scheduled messages after, ordered by their fire time (soonest first).
 */
export function sortQueuedMessages(msgs: DecryptedMessage[]): DecryptedMessage[] {
    return [...msgs].sort((a, b) => {
        const aSched = a.scheduledAt != null
        const bSched = b.scheduledAt != null
        if (aSched !== bSched) return aSched ? 1 : -1
        if (aSched && bSched) return a.scheduledAt! - b.scheduledAt!
        return (a.createdAt ?? 0) - (b.createdAt ?? 0)
    })
}

/**
 * Shared queue source for the chat surface and its floating queue entry point.
 * The thread, queue drawer, and bottom-accessory measurement must all derive
 * from the same invocation predicate.
 */
export function useQueuedMessages(sessionId: string): DecryptedMessage[] {
    const state = useSyncExternalStore(
        useCallback((listener) => subscribeMessageWindow(sessionId, listener), [sessionId]),
        useCallback(() => getMessageWindowState(sessionId), [sessionId]),
        () => EMPTY_STATE
    )

    return useMemo(() => {
        const allMessages = [...state.messages, ...state.pending]
        return sortQueuedMessages(allMessages.filter(isQueuedForInvocation))
    }, [state])
}

/** @internal Exported for unit testing. */
export function getQueuedMessagePreview(msg: DecryptedMessage): { text: string; attachmentNames: string[] } {
    const normalized = normalizeDecryptedMessage(msg)
    if (!normalized || normalized.role !== 'user') {
        return { text: '', attachmentNames: [] }
    }
    const text = (normalized.content.text ?? '').trim()
    const attachments = normalized.content.attachments ?? []
    return {
        text,
        attachmentNames: attachments.map((attachment) => attachment.filename ?? 'attachment'),
    }
}

/** @internal Exported for unit testing. */
export function getQueuedMessageEditText(preview: { text: string; attachmentNames: string[] }): string {
    return preview.text || preview.attachmentNames.join(', ')
}

/** @internal Exported for unit testing. */
export function getQueuedMessageSummary(messages: readonly DecryptedMessage[], now: number): {
    immediateCount: number
    scheduledCount: number
} {
    let immediateCount = 0
    let scheduledCount = 0

    for (const message of messages) {
        const scheduledAt = message.scheduledAt
        if (scheduledAt != null && scheduledAt > now) {
            scheduledCount += 1
        } else {
            immediateCount += 1
        }
    }

    return { immediateCount, scheduledCount }
}

/**
 * Computes the PendingSchedule to restore when editing a queued message.
 * Future scheduled messages retain their exact send time; immediate or already
 * mature messages return to the composer as an immediate send.
 */
export function computeEditPendingSchedule(
    scheduledAt: number | null | undefined,
    now: number
): PendingSchedule | null {
    if (scheduledAt == null || scheduledAt <= now) return null
    return { type: 'absolute', ms: scheduledAt }
}

/**
 * A queue action is enabled only after the hub has echoed the optimistic row.
 * Sending DELETE before that echo can otherwise race the original POST.
 */
export function computeCanCancel({
    id,
    localId,
    isPending,
}: {
    id: string
    localId: string | null | undefined
    isPending: boolean
}): boolean {
    const hasServerEcho = localId ? id !== localId : true
    return hasServerEcho && !isPending
}

function getPreviewLabel(preview: { text: string; attachmentNames: string[] }, fallback: string): string {
    return preview.text || preview.attachmentNames.join(', ') || fallback
}

/**
 * Compact queue entry plus a full bottom drawer. The entry is mounted in
 * SessionChat's floating accessory layer, so opening, adding, or clearing a
 * queue never changes the composer height or keyboard anchor.
 */
export function QueuedMessagesBar({
    sessionId,
    api,
    queuedMessages,
    onEdit,
    onExpandedChange,
}: {
    sessionId: string
    api: ApiClient | null
    queuedMessages: readonly DecryptedMessage[]
    /** Restores the selected row's schedule after it is returned to the composer. */
    onEdit?: (params: { text: string; pendingSchedule: PendingSchedule | null }) => void
    /** Lets SessionChat hide scroll controls while the drawer covers the thread. */
    onExpandedChange?: (expanded: boolean) => void
}) {
    const assistantApi = useAssistantApi()
    const cancelMutation = useCancelQueuedMessage(api)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const [open, setOpen] = useState(false)

    useEffect(() => {
        onExpandedChange?.(open)
    }, [onExpandedChange, open])

    useEffect(() => {
        return () => onExpandedChange?.(false)
    }, [onExpandedChange])

    useEffect(() => {
        if (queuedMessages.length === 0) {
            setOpen(false)
        }
    }, [queuedMessages.length])

    if (queuedMessages.length === 0) {
        return null
    }

    const now = Date.now()
    const summary = getQueuedMessageSummary(queuedMessages, now)
    const firstPreview = getQueuedMessagePreview(queuedMessages[0]!)
    const firstPreviewLabel = getPreviewLabel(firstPreview, t('queuedMessages.emptyPreview'))
    const drawerDescription = summary.immediateCount > 0 && summary.scheduledCount > 0
        ? t('queuedMessages.drawerDescriptionMixed')
        : summary.immediateCount > 0
            ? t('queuedMessages.drawerDescriptionImmediate')
            : t('queuedMessages.drawerDescriptionScheduled')

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <div
                className="pointer-events-none mx-auto flex w-full max-w-content justify-center px-3"
                data-testid="queued-messages-accessory"
            >
                <Dialog.Trigger asChild>
                    <SessionDetailQueueTrigger
                        testId="queued-messages-trigger"
                        label={t('queuedMessages.open', { count: queuedMessages.length })}
                        statusLabel={t('queuedMessages.label')}
                        preview={firstPreviewLabel}
                        count={queuedMessages.length}
                        open={open}
                    />
                </Dialog.Trigger>
            </div>

            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/25" />
                <Dialog.Content
                    data-testid="queued-messages-drawer"
                    className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[min(72dvh,38rem)] flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-bg)] pb-[max(var(--app-safe-area-bottom),0.75rem)] shadow-[0_-18px_48px_rgba(15,23,42,0.2)] animate-slide-up outline-none motion-reduce:animate-none"
                >
                    <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--app-border)]" aria-hidden="true" />
                    <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <QueueIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                                <Dialog.Title className="text-base font-bold text-[var(--app-fg)]">
                                    {t('queuedMessages.drawerTitle')}
                                </Dialog.Title>
                                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] px-1.5 text-[11px] font-bold tabular-nums text-[var(--app-hint)]">
                                    {queuedMessages.length}
                                </span>
                            </div>
                            <Dialog.Description
                                className="mt-0.5 text-xs leading-5 text-[var(--app-hint)]"
                            >
                                {drawerDescription}
                            </Dialog.Description>
                        </div>
                        <Dialog.Close
                            type="button"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </Dialog.Close>
                    </div>

                    <ul className="min-h-0 flex-1 divide-y divide-[var(--app-divider)] overflow-y-auto overscroll-contain px-5 pb-2 [scrollbar-width:thin]" aria-label={t('queuedMessages.drawerTitle')}>
                        {queuedMessages.map((message, index) => {
                            const preview = getQueuedMessagePreview(message)
                            const { text, attachmentNames } = preview
                            const editText = getQueuedMessageEditText(preview)
                            const localId = message.localId ?? message.id
                            const isPending = cancelMutation.isPending && cancelMutation.variables?.localId === localId
                            const canCancel = computeCanCancel({ id: message.id, localId: message.localId, isPending })
                            const scheduledAt = message.scheduledAt != null && message.scheduledAt > now
                                ? message.scheduledAt
                                : null
                            const waitingForSync = !canCancel && !isPending

                            const handleCancel = () => {
                                if (!canCancel) return
                                cancelMutation.mutate({
                                    sessionId,
                                    messageId: message.id,
                                    localId,
                                    snapshot: message,
                                })
                            }

                            const handleEdit = () => {
                                if (!canCancel) return
                                const restoredPendingSchedule = computeEditPendingSchedule(message.scheduledAt, Date.now())

                                cancelMutation.mutate(
                                    {
                                        sessionId,
                                        messageId: message.id,
                                        localId,
                                        snapshot: message,
                                    },
                                    {
                                        onSuccess: (result) => {
                                            if (result.status === 'invoked') {
                                                addToast({
                                                    title: t('queuedMessages.editAlreadyInvoked'),
                                                    body: '',
                                                    sessionId,
                                                    url: window.location.href,
                                                    kind: 'warning'
                                                })
                                                return
                                            }
                                            if (editText) {
                                                assistantApi.composer().setText(editText)
                                            }
                                            onEdit?.({ text: editText, pendingSchedule: restoredPendingSchedule })
                                            setOpen(false)
                                        },
                                    }
                                )
                            }

                            return (
                                <li
                                    key={message.localId ?? message.id}
                                    className="relative py-3.5 first:pt-1.5"
                                    aria-busy={isPending}
                                >
                                    <div className="flex min-w-0 items-start gap-2.5">
                                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] text-[10px] font-bold tabular-nums text-[var(--app-hint)]">
                                            {index + 1}
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            {text ? (
                                                <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--app-fg)]">
                                                    {text}
                                                </p>
                                            ) : null}
                                            {attachmentNames.length > 0 ? (
                                                <div className={text ? 'mt-1.5 flex flex-wrap gap-1.5' : 'flex flex-wrap gap-1.5'}>
                                                    {attachmentNames.map((name, attachmentIndex) => (
                                                        <span
                                                            key={`${name}-${attachmentIndex}`}
                                                            className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1 text-[11px] text-[var(--app-hint)]"
                                                            title={name}
                                                        >
                                                            <span aria-hidden="true">📎</span>
                                                            <span className="max-w-44 truncate">{name}</span>
                                                        </span>
                                                    ))}
                                                </div>
                                            ) : null}
                                            {scheduledAt !== null || waitingForSync ? (
                                                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                                                    {scheduledAt !== null ? (
                                                        <span className="inline-flex items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--app-link)]">
                                                            <ScheduleIcon className="h-3 w-3" />
                                                            {t('queuedMessages.scheduledFor', { time: formatScheduledTime(scheduledAt) })}
                                                        </span>
                                                    ) : null}
                                                    {waitingForSync ? (
                                                        <span className="text-[11px] font-medium text-[var(--app-hint)]">{t('queuedMessages.syncing')}</span>
                                                    ) : null}
                                                </div>
                                            ) : null}
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <button
                                                type="button"
                                                aria-label={t('queuedMessages.edit')}
                                                disabled={!canCancel}
                                                onClick={handleEdit}
                                                className="touch-manipulation flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                <EditIcon className="h-3.5 w-3.5" />
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={t('queuedMessages.cancel')}
                                                disabled={!canCancel}
                                                onClick={handleCancel}
                                                className="touch-manipulation flex h-9 w-9 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                                            >
                                                <CloseIcon className="h-4 w-4" />
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            )
                        })}
                    </ul>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
