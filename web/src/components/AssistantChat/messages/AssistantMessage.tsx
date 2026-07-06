import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { AgentFlavorIcon } from '@/components/AgentFlavorIcon'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import {
    formatToolGroupCompactTitle,
    isToolGroupActive,
    ToolGroupCompactHeaderProvider
} from '@/components/ToolCard/ToolGroupCard'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { MessageDetailsFooter, shouldIgnoreMessageDetailsToggle } from '@/components/AssistantChat/messages/MessageDetails'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

const COPY_BUTTON_CLASS = 'flex h-7 w-7 items-center justify-center rounded-full border border-transparent text-[var(--app-hint)] opacity-80 transition-colors hover:border-[var(--app-border)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] hover:shadow-sm'

function isToolGroupArtifact(value: unknown): value is ToolGroupBlock {
    if (!value || typeof value !== 'object') return false
    const maybe = value as Partial<ToolGroupBlock>
    return maybe.kind === 'tool-group'
        && typeof maybe.id === 'string'
        && Array.isArray(maybe.tools)
}

function AssistantToolGroupMetaBar(props: {
    block: ToolGroupBlock
    expanded: boolean
    onToggle: () => void
}) {
    const ctx = useHappyChatContext()
    const { t } = useTranslation()
    const [now, setNow] = useState(() => Date.now())
    const active = isToolGroupActive(props.block)

    useEffect(() => {
        if (!active) {
            return
        }
        setNow(Date.now())
        const interval = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(interval)
    }, [active])

    const label = formatToolGroupCompactTitle(props.block, now, t)

    return (
        <button
            type="button"
            onClick={props.onToggle}
            aria-expanded={props.expanded}
            className="mb-1 flex w-full items-center gap-1.5 text-left text-base font-medium leading-6 text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            {props.block.showAgentIcon ? (
                <AgentFlavorIcon flavor={ctx.metadata?.flavor} className="h-[1em] w-[1em] shrink-0 text-[var(--app-hint)]" />
            ) : null}
            <span>{label}</span>
            <span
                aria-hidden="true"
                className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]"
            >
                <svg
                    className={cn('h-3.5 w-3.5 transition-transform', props.expanded ? 'rotate-90' : null)}
                    viewBox="0 0 16 16"
                    fill="none"
                >
                    <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </span>
        </button>
    )
}

export function HappyAssistantMessage() {
    const ctx = useHappyChatContext()
    const { copied, copy } = useCopyToClipboard()
    const [detailsVisible, setDetailsVisible] = useState(false)
    const [showMetadata, setShowMetadata] = useState(false)
    const [compactToolGroupOpen, setCompactToolGroupOpen] = useState(false)
    const messageId = useAssistantState(({ message }) => message.id)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const codexReview = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'codex-review' ? custom.review : undefined
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const firstToolGroup = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return null
        for (const part of message.content) {
            if (part.type !== 'tool-call') continue
            const artifact = (part as { artifact?: unknown }).artifact
            if (isToolGroupArtifact(artifact)) {
                return artifact
            }
        }
        return null
    })
    const copyText = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return ''
        return getAssistantCopyText(message.content)
    })

    const invokedAt = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.invokedAt)
    const durationMs = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.durationMs)
    const usage = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.usage)
    const messageModel = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.model)
    const turnCount = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.turnCount)

    const hasMetadata = invokedAt != null
        || (typeof durationMs === 'number' && durationMs >= 0)
        || usage != null
        || (messageModel != null && messageModel !== '')
        || (typeof turnCount === 'number' && turnCount >= 2)

    const rootClass = toolOnly
        ? cn(
            'py-1 min-w-0 max-w-full overflow-x-hidden',
            ctx.terminalToolDisplayMode === 'compact' ? 'px-3' : null
        )
        : 'happy-assistant-message px-3 py-2 min-w-0 max-w-full overflow-x-hidden'
    const showCompactToolGroupHeader = ctx.terminalToolDisplayMode === 'compact' && firstToolGroup !== null && !toolOnly
    const compactToolGroupId = firstToolGroup?.id ?? null
    const firstToolGroupActive = firstToolGroup ? isToolGroupActive(firstToolGroup) : false
    const compactToolGroupContext = useMemo(() => {
        if (!showCompactToolGroupHeader || compactToolGroupId === null) {
            return null
        }
        return {
            groupId: compactToolGroupId,
            open: compactToolGroupOpen,
            setOpen: setCompactToolGroupOpen,
        }
    }, [compactToolGroupId, compactToolGroupOpen, showCompactToolGroupHeader])

    useEffect(() => {
        if (!showCompactToolGroupHeader || firstToolGroup === null) {
            setCompactToolGroupOpen(false)
            return
        }
        setCompactToolGroupOpen(firstToolGroupActive)
    }, [firstToolGroup?.id, firstToolGroupActive, showCompactToolGroupHeader])

    const toggleCompactToolGroup = () => {
        if (!firstToolGroup) {
            return
        }
        if (isToolGroupActive(firstToolGroup)) {
            setCompactToolGroupOpen(true)
            return
        }
        setCompactToolGroupOpen((open) => !open)
    }

    const toggleDetailsVisible = (event: MouseEvent<HTMLElement>) => {
        if (shouldIgnoreMessageDetailsToggle(event)) return
        setDetailsVisible((visible) => {
            const next = !visible
            if (!next) setShowMetadata(false)
            return next
        })
    }

    if (isCliOutput) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className="scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-hidden"
                onClick={toggleDetailsVisible}
            >
                <CliOutputBlock text={cliText} />
                <MessageDetailsFooter
                    visible={detailsVisible}
                    hasMetadata={hasMetadata}
                    metadataOpen={showMetadata}
                    onMetadataToggle={() => setShowMetadata((open) => !open)}
                    invokedAt={invokedAt}
                    durationMs={durationMs}
                    usage={usage}
                    model={messageModel ?? null}
                    turnCount={turnCount}
                />
            </MessagePrimitive.Root>
        )
    }

    if (codexReview) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
                onClick={toggleDetailsVisible}
            >
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        <CodexReviewCard review={codexReview} />
                        <MessageDetailsFooter
                            visible={detailsVisible}
                            hasMetadata={hasMetadata}
                            metadataOpen={showMetadata}
                            onMetadataToggle={() => setShowMetadata((open) => !open)}
                            invokedAt={invokedAt}
                            durationMs={durationMs}
                            usage={usage}
                            model={messageModel ?? null}
                            turnCount={turnCount}
                        />
                    </div>
                    {copyText ? (
                        <div className="happy-message-actions-first-line hidden sm:flex shrink-0 opacity-0 transition-opacity group-hover/msg:opacity-100">
                            <button
                                type="button"
                                title="Copy"
                                className={COPY_BUTTON_CLASS}
                                onClick={() => copy(copyText)}
                            >
                                {copied
                                    ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                    : <CopyIcon className="h-3.5 w-3.5 text-current" />}
                            </button>
                        </div>
                    ) : null}
                </div>
            </MessagePrimitive.Root>
        )
    }

    if (toolOnly) {
        return (
            <MessagePrimitive.Root
                id={getConversationMessageAnchorId(messageId)}
                className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
                onClick={toggleDetailsVisible}
            >
                <div className="min-w-0">
                    <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    <MessageDetailsFooter
                        visible={detailsVisible}
                        hasMetadata={hasMetadata}
                        metadataOpen={showMetadata}
                        onMetadataToggle={() => setShowMetadata((open) => !open)}
                        invokedAt={invokedAt}
                        durationMs={durationMs}
                        usage={usage}
                        model={messageModel ?? null}
                        turnCount={turnCount}
                    />
                </div>
            </MessagePrimitive.Root>
        )
    }

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            className={`${rootClass} ${copyText ? 'group/msg' : ''} scroll-mt-4`}
            onClick={toggleDetailsVisible}
        >
            {showCompactToolGroupHeader && firstToolGroup ? (
                <AssistantToolGroupMetaBar
                    block={firstToolGroup}
                    expanded={compactToolGroupOpen}
                    onToggle={toggleCompactToolGroup}
                />
            ) : null}
            <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                    <ToolGroupCompactHeaderProvider value={compactToolGroupContext}>
                        <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
                    </ToolGroupCompactHeaderProvider>
                    <MessageDetailsFooter
                        visible={detailsVisible}
                        hasMetadata={hasMetadata}
                        metadataOpen={showMetadata}
                        onMetadataToggle={() => setShowMetadata((open) => !open)}
                        invokedAt={invokedAt}
                        durationMs={durationMs}
                        usage={usage}
                        model={messageModel ?? null}
                        turnCount={turnCount}
                    />
                </div>
                {copyText ? (
                    <div className="happy-message-actions-first-line hidden sm:flex shrink-0 opacity-0 transition-opacity group-hover/msg:opacity-100">
                        <button
                            type="button"
                            title="Copy"
                            className={COPY_BUTTON_CLASS}
                            onClick={() => copy(copyText)}
                        >
                            {copied
                                ? <CheckIcon className="h-3.5 w-3.5 text-green-500" />
                                : <CopyIcon className="h-3.5 w-3.5 text-current" />}
                        </button>
                    </div>
                ) : null}
            </div>
        </MessagePrimitive.Root>
    )
}
