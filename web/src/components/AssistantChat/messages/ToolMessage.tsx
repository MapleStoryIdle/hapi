import { useEffect, useState } from 'react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import type { ChatBlock } from '@/chat/types'
import type { GeneratedImageBlock, ToolCallBlock } from '@/chat/types'
import type { ToolGroupBlock } from '@/chat/toolGroups'
import { isObject, safeStringify } from '@hapi/protocol'
import { isSubagentToolName } from '@/chat/subagentTool'
import { ToolGroupCard } from '@/components/ToolCard/ToolGroupCard'
import { getEventPresentation } from '@/chat/presentation'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { useHappyChatContext } from '@/components/AssistantChat/context'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { ImagePreview } from '@/components/ImagePreview'
import { useTranslation } from '@/lib/use-translation'

function isToolCallBlock(value: unknown): value is ToolCallBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'tool-call') return false
    if (typeof value.id !== 'string') return false
    if (value.localId !== null && typeof value.localId !== 'string') return false
    if (typeof value.createdAt !== 'number') return false
    if (!Array.isArray(value.children)) return false
    if (!isObject(value.tool)) return false
    if (typeof value.tool.name !== 'string') return false
    if (!('input' in value.tool)) return false
    if (value.tool.description !== null && typeof value.tool.description !== 'string') return false
    if (value.tool.state !== 'pending' && value.tool.state !== 'running' && value.tool.state !== 'completed' && value.tool.state !== 'error') return false
    return true
}

function isToolGroupBlock(value: unknown): value is ToolGroupBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'tool-group') return false
    if (typeof value.id !== 'string') return false
    if (!Array.isArray(value.tools)) return false
    return true
}

function isGeneratedImageBlock(value: unknown): value is GeneratedImageBlock {
    if (!isObject(value)) return false
    if (value.kind !== 'generated-image') return false
    if (typeof value.id !== 'string') return false
    if (typeof value.imageId !== 'string') return false
    if (typeof value.fileName !== 'string') return false
    if (value.mimeType !== null && typeof value.mimeType !== 'string') return false
    if (value.sourcePath !== undefined && value.sourcePath !== null && typeof value.sourcePath !== 'string') return false
    return true
}

function GeneratedImageCard(props: { block: GeneratedImageBlock }) {
    const ctx = useHappyChatContext()
    const [objectUrl, setObjectUrl] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let disposed = false
        let nextObjectUrl: string | null = null

        setObjectUrl(null)
        setError(null)
        void ctx.api.getGeneratedImageBlob(ctx.sessionId, props.block.imageId)
            .then((blob) => {
                if (disposed) return
                nextObjectUrl = URL.createObjectURL(blob)
                setObjectUrl(nextObjectUrl)
            })
            .catch((err: unknown) => {
                if (disposed) return
                setError(err instanceof Error ? err.message : 'Failed to load generated image')
            })

        return () => {
            disposed = true
            if (nextObjectUrl) {
                URL.revokeObjectURL(nextObjectUrl)
            }
        }
    }, [ctx.api, ctx.sessionId, props.block.imageId])

    if (objectUrl) {
        return (
            <ImagePreview
                src={objectUrl}
                fileName={props.block.fileName}
                viewerTitle={props.block.sourcePath ?? props.block.fileName}
                label={props.block.fileName}
                buttonClassName="inline-block max-w-full cursor-zoom-in overflow-hidden rounded-[24px] text-left align-top"
                imageClassName="max-h-[min(20rem,42vh)] max-w-full rounded-[24px] border border-[var(--app-border)] object-contain shadow-sm"
            />
        )
    }

    if (error) {
        return (
            <div className="text-sm text-[var(--app-hint)]">
                Generated image is unavailable. {error}
            </div>
        )
    }

    return <div className="h-48 w-72 max-w-full animate-pulse rounded-xl bg-[var(--app-subtle-bg)]" />
}

function isPendingPermissionBlock(block: ChatBlock): boolean {
    return block.kind === 'tool-call' && block.tool.permission?.status === 'pending'
}

function splitTaskChildren(block: ToolCallBlock): { pending: ChatBlock[]; rest: ChatBlock[] } {
    const pending: ChatBlock[] = []
    const rest: ChatBlock[] = []

    for (const child of block.children) {
        if (isPendingPermissionBlock(child)) {
            pending.push(child)
        } else {
            rest.push(child)
        }
    }

    return { pending, rest }
}

function TitleChangedEvent(props: { title: string }) {
    const { t } = useTranslation()
    const title = props.title.trim()

    return (
        <div className="py-1" data-title-change-event>
            <div className="mx-auto flex w-fit max-w-[92%] items-center gap-1.5 px-2 py-0.5 text-xs leading-5 text-[var(--app-hint)]">
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" aria-hidden="true">
                    <path d="M3 11.75V13h1.25l7.1-7.1-1.25-1.25-7.1 7.1Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                    <path d="m9.45 4.55 1.25 1.25.8-.8a.88.88 0 0 0 0-1.25l-.55-.55a.88.88 0 0 0-1.25 0l-.8.8Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                </svg>
                <span className="shrink-0">{t('agentEvent.titleChanged')}</span>
                {title ? (
                    <span className="max-w-[15rem] truncate font-medium text-[var(--app-fg)]" title={title}>
                        {title}
                    </span>
                ) : null}
            </div>
        </div>
    )
}

function HappyNestedBlockList(props: {
    blocks: ChatBlock[]
}) {
    const ctx = useHappyChatContext()

    return (
        <div className="flex flex-col gap-3">
            {props.blocks.map((block) => {
                if (block.kind === 'user-text') {
                    const status = block.status
                    const canRetry = status === 'failed' && typeof block.localId === 'string' && Boolean(ctx.onRetryMessage)
                    const onRetry = canRetry ? () => ctx.onRetryMessage!(block.localId!) : undefined
                    const showStatus = shouldShowMessageStatus(status)

                    return (
                        <div key={`user:${block.id}`} className={getUserBubbleClassName(status)}>
                            <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <UserBubbleContent text={block.text} />
                                </div>
                                {showStatus ? (
                                    <div className="happy-message-actions-first-line shrink-0">
                                        <MessageStatusIndicator status={status} onRetry={onRetry} />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'agent-text') {
                    return (
                        <div key={`agent:${block.id}`} className="px-1">
                            <MarkdownRenderer content={block.text} />
                        </div>
                    )
                }

                if (block.kind === 'cli-output') {
                    const alignClass = block.source === 'user' ? 'ml-auto w-full max-w-[92%]' : ''
                    return (
                        <div key={`cli:${block.id}`} className="px-1 min-w-0 max-w-full overflow-x-hidden">
                            <div className={alignClass}>
                                <CliOutputBlock text={block.text} />
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'generated-image') {
                    return (
                        <div key={`generated-image:${block.id}`} className="px-1">
                            <GeneratedImageCard block={block} />
                        </div>
                    )
                }

                if (block.kind === 'agent-event') {
                    if (block.event.type === 'title-changed' && typeof block.event.title === 'string') {
                        return <TitleChangedEvent key={`event:${block.id}`} title={block.event.title} />
                    }

                    const presentation = getEventPresentation(block.event)
                    return (
                        <div key={`event:${block.id}`} className="py-1">
                            <div className="mx-auto w-fit max-w-[92%] px-2 text-center text-xs text-[var(--app-hint)] opacity-80">
                                <span className="inline-flex items-center gap-1">
                                    {presentation.icon ? <span aria-hidden="true">{presentation.icon}</span> : null}
                                    <span>{presentation.text}</span>
                                </span>
                            </div>
                        </div>
                    )
                }

                if (block.kind === 'tool-call') {
                    const isTask = isSubagentToolName(block.tool.name)
                    const hideChildren = block.tool.name === 'CodexAgent'
                    const taskChildren = isTask ? splitTaskChildren(block) : null

                    return (
                        <div key={`tool:${block.id}`} className="py-1">
                            <ToolCard
                                api={ctx.api}
                                sessionId={ctx.sessionId}
                                metadata={ctx.metadata}
                                terminalToolDisplayMode={ctx.terminalToolDisplayMode}
                                disabled={ctx.disabled}
                                onDone={ctx.onRefresh}
                                block={block}
                            />
                            {!hideChildren && block.children.length > 0 ? (
                                isTask ? (
                                    <>
                                        {taskChildren && taskChildren.pending.length > 0 ? (
                                            <div className="mt-2 pl-3">
                                                <HappyNestedBlockList blocks={taskChildren.pending} />
                                            </div>
                                        ) : null}
                                        {taskChildren && taskChildren.rest.length > 0 ? (
                                            <details className="mt-2">
                                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                                    Task details ({taskChildren.rest.length})
                                                </summary>
                                                <div className="mt-2 pl-3">
                                                    <HappyNestedBlockList blocks={taskChildren.rest} />
                                                </div>
                                            </details>
                                        ) : null}
                                    </>
                                ) : (
                                    <div className="mt-2 pl-3">
                                        <HappyNestedBlockList blocks={block.children} />
                                    </div>
                                )
                            ) : null}
                        </div>
                    )
                }

                return null
            })}
        </div>
    )
}

export function HappyToolMessage(props: ToolCallMessagePartProps) {
    const ctx = useHappyChatContext()
    const artifact = props.artifact

    if (isToolGroupBlock(artifact)) {
        return (
            <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
                <ToolGroupCard
                    block={artifact}
                    metadata={ctx.metadata}
                />
            </div>
        )
    }

    if (isGeneratedImageBlock(artifact)) {
        return (
            <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
                <GeneratedImageCard block={artifact} />
            </div>
        )
    }

    if (!isToolCallBlock(artifact)) {
        const argsText = typeof props.argsText === 'string' ? props.argsText.trim() : ''
        const hasArgsText = argsText.length > 0
        const hasResult = props.result !== undefined
        const resultText = hasResult ? safeStringify(props.result) : ''

        return (
            <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
                <div className="overflow-hidden rounded-[20px] bg-[var(--app-tool-card-bg)] p-3 shadow-none">
                    <div className="flex items-center gap-2 text-xs">
                        <div className="font-mono text-[var(--app-tool-card-accent)]">
                            Tool: {props.toolName}
                        </div>
                        {props.isError ? (
                            <span className="text-red-500">Error</span>
                        ) : null}
                        {props.status.type === 'running' && !hasResult ? (
                            <span className="text-[var(--app-hint)]">Running…</span>
                        ) : null}
                    </div>

                    {hasArgsText ? (
                        <div className="mt-2">
                            <CodeBlock code={argsText} language="json" title="Input" />
                        </div>
                    ) : null}

                    {hasResult ? (
                        <div className="mt-2">
                            <CodeBlock code={resultText} language={typeof props.result === 'string' ? 'text' : 'json'} title="Output" />
                        </div>
                    ) : null}
                </div>
            </div>
        )
    }

    const block = artifact
    const isTask = isSubagentToolName(block.tool.name)
    const hideChildren = block.tool.name === 'CodexAgent'
    const taskChildren = isTask ? splitTaskChildren(block) : null

    return (
        <div className="py-1 min-w-0 max-w-full overflow-x-hidden">
            <ToolCard
                api={ctx.api}
                sessionId={ctx.sessionId}
                metadata={ctx.metadata}
                terminalToolDisplayMode={ctx.terminalToolDisplayMode}
                disabled={ctx.disabled}
                onDone={ctx.onRefresh}
                block={block}
            />
            {!hideChildren && block.children.length > 0 ? (
                isTask ? (
                    <>
                        {taskChildren && taskChildren.pending.length > 0 ? (
                            <div className="mt-2 pl-3">
                                <HappyNestedBlockList blocks={taskChildren.pending} />
                            </div>
                        ) : null}
                        {taskChildren && taskChildren.rest.length > 0 ? (
                            <details className="mt-2">
                                <summary className="cursor-pointer text-xs text-[var(--app-hint)]">
                                    Task details ({taskChildren.rest.length})
                                </summary>
                                <div className="mt-2 pl-3">
                                    <HappyNestedBlockList blocks={taskChildren.rest} />
                                </div>
                            </details>
                        ) : null}
                    </>
                ) : (
                    <div className="mt-2 pl-3">
                        <HappyNestedBlockList blocks={block.children} />
                    </div>
                )
            ) : null}
        </div>
    )
}
