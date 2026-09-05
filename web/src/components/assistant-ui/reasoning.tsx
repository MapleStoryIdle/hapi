import { useState, type FC } from 'react'
import { useMessage, type ReasoningGroupProps } from '@assistant-ui/react'
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

export const ReasoningGroup: FC<ReasoningGroupProps> = ({ children, startIndex, endIndex }) => {
    const [isOpen, setIsOpen] = useState(false)
    const { t } = useTranslation()
    const message = useMessage()
    const isStreaming = message.status?.type === 'running'
        && endIndex === message.content.length - 1
        && message.content.length > 0
        && message.content[message.content.length - 1]?.type === 'reasoning'
    const preview = getReasoningPreview(message.content.slice(startIndex, endIndex + 1))
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
