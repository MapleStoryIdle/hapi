import type { MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import { MessageMetadata, type MessageMetadataProps } from '@/components/AssistantChat/messages/MessageMetadata'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'

export function shouldIgnoreMessageDetailsToggle(event: MouseEvent<HTMLElement>): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false

    if (target.closest('button,a,input,textarea,select,summary,[role="button"],[role="link"],[data-message-details-ignore]')) {
        return true
    }

    const selection = window.getSelection()
    return Boolean(selection?.toString().trim())
}

export function MessageDetailsFooter(props: MessageMetadataProps & {
    visible: boolean
    hasMetadata: boolean
    metadataOpen: boolean
    onMetadataToggle: () => void
    align?: 'left' | 'right'
}) {
    if (!props.visible) return null

    const align = props.align ?? 'left'

    return (
        <>
            <div className={cn(
                'mt-2 flex items-center gap-2',
                align === 'right' ? 'justify-end' : 'justify-start'
            )}>
                <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                {props.hasMetadata ? (
                    <button
                        type="button"
                        onClick={(event) => {
                            event.stopPropagation()
                            props.onMetadataToggle()
                        }}
                        aria-expanded={props.metadataOpen}
                        className="text-[10px] text-[var(--app-hint)] underline-offset-2 hover:text-[var(--app-fg)] hover:underline"
                    >
                        {props.metadataOpen ? 'Hide info' : 'Show info'}
                    </button>
                ) : null}
            </div>
            {props.metadataOpen ? (
                <MessageMetadata
                    invokedAt={props.invokedAt}
                    durationMs={props.durationMs}
                    usage={props.usage}
                    model={props.model}
                    turnCount={props.turnCount}
                    className={props.className}
                />
            ) : null}
        </>
    )
}
