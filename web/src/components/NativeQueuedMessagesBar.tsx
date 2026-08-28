import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Clock3, X } from 'lucide-react'
import type { CodexLocalSessionQueuedMessage } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { QueueIcon, SessionDetailQueueTrigger } from '@/components/SessionDetailQueueTrigger'

/**
 * Queue affordance for an original native Codex thread.
 *
 * Native prompts are not HAPI messages, so they intentionally do not use the
 * HAPI queued-message mutation (there is no HAPI session row to cancel). The
 * runner owns delivery; this component only exposes a truthful read-only view
 * of the FIFO waiting list returned by the native status endpoint.
 */
export function NativeQueuedMessagesBar(props: {
    messages: readonly CodexLocalSessionQueuedMessage[]
    onExpandedChange?: (expanded: boolean) => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
        props.onExpandedChange?.(open)
        return () => props.onExpandedChange?.(false)
    }, [open, props.onExpandedChange])

    React.useEffect(() => {
        if (props.messages.length === 0) {
            setOpen(false)
        }
    }, [props.messages.length])

    if (props.messages.length === 0) {
        return null
    }

    // Match the HAPI queue entry: show the first pending prompt as the quick
    // preview, while the drawer remains the place for the complete list.
    const preview = props.messages[0]?.text.trim() || t('queuedMessages.emptyPreview')

    return (
        <Dialog.Root open={open} onOpenChange={setOpen}>
            <div className="pointer-events-none mx-auto w-full max-w-content px-3" data-testid="native-queued-messages-accessory">
                <Dialog.Trigger asChild>
                    <SessionDetailQueueTrigger
                        testId="native-queued-messages-trigger"
                        label={t('queuedMessages.open', { count: props.messages.length })}
                        preview={preview}
                        count={props.messages.length}
                        open={open}
                    />
                </Dialog.Trigger>
            </div>

            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/25" />
                <Dialog.Content
                    data-testid="native-queued-messages-drawer"
                    className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[min(72dvh,38rem)] flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-bg)] pb-[max(var(--app-safe-area-bottom),0.75rem)] shadow-[0_-18px_48px_rgba(15,23,42,0.2)] animate-slide-up outline-none motion-reduce:animate-none"
                >
                    <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--app-border)]" aria-hidden="true" />
                    <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4">
                        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]">
                            <QueueIcon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <Dialog.Title className="text-base font-bold text-[var(--app-fg)]">
                                    {t('queuedMessages.drawerTitle')}
                                </Dialog.Title>
                                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] px-1.5 text-[11px] font-bold tabular-nums text-[var(--app-hint)]">
                                    {props.messages.length}
                                </span>
                            </div>
                            <Dialog.Description className="mt-0.5 text-xs leading-5 text-[var(--app-hint)]">
                                {t('recentCodex.queue.drawerDescription')}
                            </Dialog.Description>
                        </div>
                        <Dialog.Close
                            type="button"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </Dialog.Close>
                    </div>
                    <div className="mx-5 mb-3 flex items-center gap-2 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2.5 text-xs text-[var(--app-hint)]">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--app-bg)] text-[var(--app-hint)]">
                            <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">{t('recentCodex.queue.afterCurrentTurn')}</span>
                        <span className="font-bold tabular-nums text-[var(--app-fg)]">{props.messages.length}</span>
                    </div>
                    <ol className="min-h-0 flex-1 space-y-2.5 overflow-y-auto overscroll-contain px-5 pb-2 [scrollbar-width:thin]">
                        {props.messages.map((message, index) => (
                            <li
                                key={message.id}
                                className="relative overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"
                            >
                                <div className="flex min-w-0 items-start gap-3">
                                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-[var(--app-subtle-bg)] text-[11px] font-bold tabular-nums text-[var(--app-hint)]">
                                        {String(index + 1).padStart(2, '0')}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                                            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--app-hint)]">
                                                <QueueIcon className="h-3 w-3" />
                                                {t('queuedMessages.afterCurrentRun')}
                                            </span>
                                        </div>
                                        <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--app-fg)]">
                                            {message.text}
                                        </p>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
