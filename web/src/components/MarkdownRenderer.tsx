import type { MarkdownTextPrimitiveProps } from '@assistant-ui/react-markdown'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { TextMessagePartProvider } from '@assistant-ui/react'
import ReactMarkdown, { type Options as ReactMarkdownOptions } from 'react-markdown'
import type { ComponentPropsWithoutRef } from 'react'
import {
    MARKDOWN_REHYPE_PLUGINS,
    MARKDOWN_COMPONENTS_BY_LANGUAGE,
    MARKDOWN_CLASSNAME,
    defaultComponents,
    denyOnlyTransform,
    UriConfirmProvider,
    useMarkdownRemarkPlugins,
} from '@/components/assistant-ui/markdown-text'
import { cn } from '@/lib/utils'

interface MarkdownRendererProps {
    content: string
    components?: MarkdownTextPrimitiveProps['components']
    className?: string
    preserveSingleLineBreaks?: boolean
    standalone?: boolean
}

function StandalonePre(props: ComponentPropsWithoutRef<'pre'>) {
    const { className, ...rest } = props

    return (
        <div className="aui-md-pre-wrapper min-w-0 w-full max-w-full overflow-x-auto overflow-y-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-code-bg)]">
            <pre
                {...rest}
                className={cn('aui-md-pre m-0 w-max min-w-full bg-transparent px-4 py-3 text-[0.93rem] leading-6', className)}
            />
        </div>
    )
}

function StandaloneCode(props: ComponentPropsWithoutRef<'code'>) {
    const { className, children, ...rest } = props
    const text = typeof children === 'string'
        ? children
        : Array.isArray(children)
            ? children.map((child) => typeof child === 'string' ? child : '').join('')
            : ''
    const isCodeBlock = /\blanguage-/.test(className ?? '') || text.includes('\n')

    if (isCodeBlock) {
        return (
            <code
                {...rest}
                className={cn('aui-md-codeblockcode font-mono', className)}
            >
                {children}
            </code>
        )
    }

    return (
        <code
            {...rest}
            className={cn(
                'aui-md-code break-words rounded-md border border-[var(--app-inline-code-border)] bg-[var(--app-inline-code-bg)] px-[0.38em] py-[0.14em] font-mono text-[0.86em] text-[var(--app-inline-code-fg)]',
                className
            )}
        >
            {children}
        </code>
    )
}

function MarkdownContent(props: MarkdownRendererProps) {
    const remarkPlugins = useMarkdownRemarkPlugins(props.preserveSingleLineBreaks)

    if (props.standalone) {
        const mergedComponents = {
            ...defaultComponents,
            pre: StandalonePre,
            code: StandaloneCode,
            ...props.components
        } as ReactMarkdownOptions['components']

        return (
            <UriConfirmProvider>
                <div className={cn(MARKDOWN_CLASSNAME, props.className)}>
                    <ReactMarkdown
                        remarkPlugins={remarkPlugins}
                        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                        components={mergedComponents}
                        urlTransform={denyOnlyTransform}
                    >
                        {props.content}
                    </ReactMarkdown>
                </div>
            </UriConfirmProvider>
        )
    }

    const mergedComponents = props.components
        ? { ...defaultComponents, ...props.components }
        : defaultComponents

    return (
        <UriConfirmProvider>
            <TextMessagePartProvider text={props.content}>
                <MarkdownTextPrimitive
                    remarkPlugins={remarkPlugins}
                    rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
                    components={mergedComponents}
                    componentsByLanguage={MARKDOWN_COMPONENTS_BY_LANGUAGE}
                    urlTransform={denyOnlyTransform}
                    className={cn(MARKDOWN_CLASSNAME, props.className)}
                />
            </TextMessagePartProvider>
        </UriConfirmProvider>
    )
}

export function MarkdownRenderer(props: MarkdownRendererProps) {
    return <MarkdownContent {...props} />
}
