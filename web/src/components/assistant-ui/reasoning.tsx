import { useState, type FC, type PropsWithChildren } from 'react'
import { useMessage } from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import {
    MARKDOWN_CLASSNAME,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_REHYPE_PLUGINS,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
    useMarkdownRemarkPlugins,
} from '@/components/assistant-ui/markdown-text'

function ChevronIcon(props: { className?: string; open?: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
                'transition-transform duration-200 motion-reduce:transition-none',
                props.open ? 'rotate-90' : '',
                props.className
            )}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function ThoughtTraceIcon(props: { streaming: boolean }) {
    return (
        <span
            aria-hidden="true"
            className="relative flex h-5 w-5 shrink-0 items-center justify-center text-[var(--app-hint)]"
        >
            <svg viewBox="0 0 20 20" className="h-[18px] w-[18px] overflow-visible" fill="none">
                <path
                    d="M3.5 10h4m1.5 0 3-4m-3 4 3 4m0-8h3.5m-3.5 8h3.5"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity="0.62"
                />
                <circle cx="3" cy="10" r="1.55" fill="currentColor" opacity="0.72" />
                <circle cx="8.5" cy="10" r="1.45" fill="currentColor" opacity="0.82" />
                <circle
                    cx="16"
                    cy="6"
                    r="1.6"
                    fill="currentColor"
                    className={cn(props.streaming && 'motion-safe:animate-pulse')}
                />
                <circle
                    cx="16"
                    cy="14"
                    r="1.6"
                    fill="currentColor"
                    className={cn(props.streaming && 'motion-safe:animate-pulse')}
                    style={props.streaming ? { animationDelay: '350ms' } : undefined}
                />
            </svg>
        </span>
    )
}

function getReasoningPreview(content: readonly unknown[]): string {
    const preview = content
        .map((part) => {
            if (!part || typeof part !== 'object') return ''
            const candidate = part as { type?: unknown; text?: unknown }
            return candidate.type === 'reasoning' && typeof candidate.text === 'string'
                ? candidate.text
                : ''
        })
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    return preview.length > 180 ? `${preview.slice(0, 179)}…` : preview
}

export const Reasoning: FC = () => {
    const remarkPlugins = useMarkdownRemarkPlugins()

    return (
        <UriConfirmProvider>
            <MarkdownTextPrimitive
                remarkPlugins={remarkPlugins}
                rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                components={defaultComponents}
                componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                urlTransform={denyOnlyTransform}
                className={cn(MARKDOWN_CLASSNAME, 'aui-reasoning-content text-[13px] leading-[1.65] text-[var(--app-hint)]')}
            />
        </UriConfirmProvider>
    )
}

export const ReasoningGroup: FC<PropsWithChildren> = ({ children }) => {
    const [isOpen, setIsOpen] = useState(false)
    const { t } = useTranslation()
    const message = useMessage()
    const isStreaming = message.status?.type === 'running'
        && message.content.length > 0
        && message.content[message.content.length - 1]?.type === 'reasoning'
    const preview = getReasoningPreview(message.content)
    const label = isStreaming ? t('session.item.thinking') : t('misc.reasoning')

    return (
        <div className="aui-reasoning-group my-1.5 min-w-0">
            <button
                type="button"
                onClick={() => setIsOpen((open) => !open)}
                aria-expanded={isOpen}
                className={cn(
                    'group flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[13px] leading-5',
                    'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                    'cursor-pointer select-none transition-colors hover:bg-[var(--app-subtle-bg)]',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
                )}
            >
                <ThoughtTraceIcon streaming={isStreaming} />
                <span className="shrink-0 font-medium text-[var(--app-hint)] group-hover:text-[var(--app-fg)]">
                    {label}
                </span>
                {!isOpen && preview ? (
                    <span className="min-w-0 flex-1 truncate font-normal opacity-80">
                        <span aria-hidden="true" className="mx-1 opacity-60">·</span>
                        {preview}
                    </span>
                ) : <span className="flex-1" />}
                <ChevronIcon open={isOpen} className="mr-0.5 shrink-0 opacity-70" />
            </button>

            <div
                className={cn(
                    'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
                    isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                )}
            >
                <div className="min-h-0 overflow-hidden">
                    <div className="ml-[15px] border-l border-[var(--app-divider)] py-1.5 pl-4 pr-1">
                        {children}
                    </div>
                </div>
            </div>
        </div>
    )
}
