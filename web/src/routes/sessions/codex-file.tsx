import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { CheckIcon, CopyIcon } from '@/components/icons'
import { FileIcon } from '@/components/FileIcon'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { useAppContext } from '@/lib/app-context'
import { formatReadFileError } from '@/lib/files-i18n'
import { queryKeys } from '@/lib/query-keys'
import { langAlias, useShikiHighlighter } from '@/lib/shiki'
import { useTranslation } from '@/lib/use-translation'
import { decodeBase64 } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'

function resolveLanguage(path: string): string | undefined {
    const extension = path.split('.').pop()?.toLowerCase()
    return extension ? (langAlias[extension] ?? extension) : undefined
}

function isBinaryContent(content: string): boolean {
    if (!content) return false
    if (content.includes('\0')) return true
    const nonPrintable = content.split('').filter((char) => {
        const code = char.charCodeAt(0)
        return code < 32 && code !== 9 && code !== 10 && code !== 13
    }).length
    return nonPrintable / content.length > 0.1
}

function NativeSourceCodeView(props: {
    content: string
    highlighted: ReactNode | null
    targetLine?: number
}) {
    const lineRefs = useRef(new Map<number, HTMLDivElement>())
    const lines = useMemo(() => props.content.split('\n'), [props.content])
    const lineNumberWidth = `${String(Math.max(lines.length, 1)).length + 1}ch`

    useEffect(() => {
        if (!props.targetLine) return
        const node = lineRefs.current.get(props.targetLine)
        if (!node) return

        const frame = window.requestAnimationFrame(() => {
            node.scrollIntoView({ block: 'center', inline: 'nearest' })
        })
        return () => window.cancelAnimationFrame(frame)
    }, [props.content, props.targetLine])

    if (!props.targetLine) {
        return (
            <pre className="shiki overflow-auto rounded-md bg-[var(--app-code-bg)] p-3 text-xs font-mono">
                <code>{props.highlighted ?? props.content}</code>
            </pre>
        )
    }

    return (
        <pre className="overflow-auto rounded-md bg-[var(--app-code-bg)] py-3 text-xs font-mono">
            <code className="block min-w-max">
                {lines.map((line, index) => {
                    const lineNumber = index + 1
                    const isTarget = lineNumber === props.targetLine
                    return (
                        <div
                            key={lineNumber}
                            ref={(node) => {
                                if (node) {
                                    lineRefs.current.set(lineNumber, node)
                                } else {
                                    lineRefs.current.delete(lineNumber)
                                }
                            }}
                            className={[
                                'flex min-w-max scroll-mt-20 leading-5',
                                isTarget ? 'bg-amber-500/20 ring-1 ring-inset ring-amber-400/50' : ''
                            ].filter(Boolean).join(' ')}
                        >
                            <span
                                className={[
                                    'select-none px-2 text-right text-[var(--app-hint)]',
                                    isTarget ? 'font-semibold text-amber-600 dark:text-amber-300' : ''
                                ].filter(Boolean).join(' ')}
                                style={{ width: lineNumberWidth }}
                            >
                                {lineNumber}
                            </span>
                            <span className="whitespace-pre px-3">{line || ' '}</span>
                        </div>
                    )
                })}
            </code>
        </pre>
    )
}

export default function CodexFilePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { copied: pathCopied, copy: copyPath } = useCopyToClipboard()
    const { copied: contentCopied, copy: copyContent } = useCopyToClipboard()
    const { codexSessionId } = useParams({ from: '/sessions/codex/$codexSessionId/file' })
    const { machineId, path: encodedPath, line: targetLine } = useSearch({ from: '/sessions/codex/$codexSessionId/file' })
    const goBack = useCallback(() => {
        void navigate({
            to: '/sessions/codex/$codexSessionId',
            params: { codexSessionId },
            search: machineId ? { machineId } : {}
        })
    }, [codexSessionId, machineId, navigate])
    const filePath = useMemo(() => {
        const decoded = decodeBase64(encodedPath)
        return decoded.ok ? decoded.text : encodedPath
    }, [encodedPath])
    const fileName = filePath.split('/').pop() || filePath || t('file.page.fallbackName')

    const fileQuery = useQuery({
        queryKey: queryKeys.codexSessionFile(machineId ?? '', codexSessionId, filePath),
        queryFn: async () => {
            if (!api || !machineId || !filePath) {
                throw new Error('Missing runner or path')
            }
            return await api.readCodexSessionFile(codexSessionId, machineId, filePath)
        },
        enabled: Boolean(api && machineId && filePath)
    })

    const fileResult = fileQuery.data
    const decodedContentResult = fileResult?.success && fileResult.content
        ? decodeBase64(fileResult.content)
        : { text: '', ok: true }
    const decodedContent = decodedContentResult.text
    const binaryFile = fileResult?.success === true && (!decodedContentResult.ok || isBinaryContent(decodedContent))
    const highlighted = useShikiHighlighter(binaryFile ? '' : decodedContent, resolveLanguage(filePath))
    const requestError = fileQuery.error
        ? (fileQuery.error instanceof Error ? fileQuery.error.message : String(fileQuery.error))
        : null
    const readError = !machineId
        ? t('recentCodex.runnerRequired')
        : fileResult && !fileResult.success
            ? (fileResult.error ?? 'Failed to read file')
            : requestError
    const readErrorMessage = readError ? formatReadFileError(readError, t) : null

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionDetailHeader
                title={fileName}
                subtitle={filePath || t('file.page.unknownPath')}
                onBack={goBack}
            />

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2">
                    <FileIcon fileName={fileName} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">{filePath || t('file.page.unknownPath')}</span>
                    <button
                        type="button"
                        onClick={() => copyPath(filePath)}
                        className="shrink-0 rounded p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        title={t('file.page.copyPath')}
                    >
                        {pathCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                    {fileResult?.success === true && !binaryFile && decodedContent ? (
                        <button
                            type="button"
                            onClick={() => copyContent(decodedContent)}
                            className="shrink-0 rounded p-1 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                            title={t('file.page.copyContent')}
                        >
                            {contentCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="app-scroll-y flex-1 min-h-0">
                <div className="mx-auto w-full max-w-content p-4">
                    {!filePath ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.missingPath')}</div>
                    ) : fileQuery.isLoading ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('loading.file')}</div>
                    ) : readErrorMessage ? (
                        <div className="text-sm text-[var(--app-hint)]">{readErrorMessage}</div>
                    ) : binaryFile ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.binary')}</div>
                    ) : decodedContent ? (
                        <NativeSourceCodeView
                            content={decodedContent}
                            highlighted={highlighted}
                            targetLine={targetLine}
                        />
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.empty')}</div>
                    )}
                </div>
            </div>
        </div>
    )
}
