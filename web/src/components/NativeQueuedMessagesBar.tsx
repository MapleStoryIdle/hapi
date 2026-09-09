import * as React from 'react'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { Loader2, Play } from 'lucide-react'
import type { CodexLocalSessionQueuedMessage } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { SessionDetailQueueTrigger } from '@/components/SessionDetailQueueTrigger'

/**
 * Queue affordance for an original native Codex thread.
 *
 * Native prompts are not SHAPI messages, so they intentionally do not use the
 * SHAPI queued-message mutation (there is no SHAPI session row to cancel). The
 * runner owns delivery; this component only exposes a truthful read-only view
 * of the FIFO waiting list returned by the native status endpoint.
 */
export function NativeQueuedMessagesBar(props: {
    messages: readonly CodexLocalSessionQueuedMessage[]
    onExpandedChange?: (expanded: boolean) => void
    paused?: boolean
    resuming?: boolean
    resumeDisabled?: boolean
    onResume?: () => void
}) {
    const { t } = useTranslation()
    const [open, setOpen] = React.useState(false)

    React.useEffect(() => {
        props.onExpandedChange?.(open)
        return () => props.onExpandedChange?.(false)
    }, [open, props.onExpandedChange])

    React.useEffect(() => {
        if (props.messages.length === 0 && !props.paused) {
            setOpen(false)
        }
    }, [props.messages.length, props.paused])

    // Match the SHAPI queue entry: show the first pending prompt as the quick
    // preview, while the drawer remains the place for the complete list.
    const preview = props.messages[0]?.text.trim() || t(props.paused ? 'recentCodex.control.queuePaused' : 'queuedMessages.emptyPreview')

    return (
        <>
            {props.messages.length > 0 || props.paused ? <div className="pointer-events-none mx-auto flex w-full max-w-content justify-center px-3" data-testid="native-queued-messages-accessory">

                    <SessionDetailQueueTrigger
                        testId="native-queued-messages-trigger"
                        label={t('queuedMessages.open', { count: props.messages.length })}
                        statusLabel={t(props.paused ? 'recentCodex.control.paused' : 'queuedMessages.label')}
                        preview={preview}
                        count={props.messages.length}
                        open={open}
                        onClick={() => setOpen(true)}
                    />

            </div> : null}

            <BottomDrawer open={open && (props.messages.length > 0 || props.paused === true)} onOpenChange={setOpen}
                title={t('queuedMessages.drawerTitle')}
                subtitle={t(props.paused ? 'recentCodex.control.queuePaused' : 'recentCodex.queue.drawerDescription')}
                testId="native-queued-messages-drawer"
                accessory={props.paused && props.onResume ? <div className="flex justify-end px-5 pb-2">
                    <button type="button" aria-label={t('recentCodex.control.resumeQueue')}
                        disabled={props.resuming || props.resumeDisabled} onClick={props.onResume}
                        className="flex h-11 w-11 items-center justify-center text-[var(--app-link)] disabled:opacity-40">
                        {props.resuming ? <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play className="h-5 w-5" aria-hidden="true" />}
                    </button>
                </div> : null}
            >
                    <ol className="divide-y divide-[var(--app-divider)] pb-2">
                        {props.messages.map((message, index) => (
                            <li
                                key={message.id}
                                className="relative py-3.5 first:pt-1.5"
                            >
                                <div className="flex min-w-0 items-start gap-2.5">
                                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] text-[10px] font-bold tabular-nums text-[var(--app-hint)]">
                                        {index + 1}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--app-fg)]">
                                            {message.text}
                                        </p>
                                        {message.recoveryRequired ? (
                                            <span className="mt-1.5 inline-flex items-center rounded-full bg-[color-mix(in_srgb,#f59e0b_12%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                                                {t('recentCodex.queue.recoveryRequired')}
                                            </span>
                                        ) : null}
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ol>
            </BottomDrawer>
        </>
    )
}
