import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearch } from '@tanstack/react-router'
import type { GitCommandResponse } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { formatDiffError, formatReadFileError } from '@/lib/files-i18n'
import { queryKeys } from '@/lib/query-keys'
import { langAlias, useShikiHighlighter } from '@/lib/shiki'
import { useTranslation } from '@/lib/use-translation'
import { decodeBase64 } from '@/lib/utils'
import { ImagePreview } from '@/components/ImagePreview'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'

const MAX_COPYABLE_FILE_BYTES = 1_000_000
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
    apng: 'image/apng',
    avif: 'image/avif',
    bmp: 'image/bmp',
    gif: 'image/gif',
    ico: 'image/x-icon',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    webp: 'image/webp'
}

function decodePath(value: string): string {
    if (!value) return ''
    const decoded = decodeBase64(value)
    return decoded.ok ? decoded.text : value
}

function DownloadIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
    )
}

function triggerBase64Download(fileName: string, base64Content: string, mimeType: string | null) {
    const byteChars = atob(base64Content)
    const byteArray = new Uint8Array(byteChars.length)
    for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i)
    }
    const blob = new Blob([byteArray], { type: mimeType ?? 'application/octet-stream' })
    triggerBlobDownload(fileName, blob)
}

function triggerBlobDownload(fileName: string, blob: Blob) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
}

function DiffDisplay(props: { diffContent: string }) {
    const lines = props.diffContent.split('\n')

    return (
        <div className="overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-bg)]">
            {lines.map((line, index) => {
                const isAdd = line.startsWith('+') && !line.startsWith('+++')
                const isRemove = line.startsWith('-') && !line.startsWith('---')
                const isHunk = line.startsWith('@@')
                const isHeader = line.startsWith('+++') || line.startsWith('---')

                const className = [
                    'whitespace-pre-wrap px-3 py-0.5 text-xs font-mono',
                    isAdd ? 'bg-[var(--app-diff-added-bg)] text-[var(--app-diff-added-text)]' : '',
                    isRemove ? 'bg-[var(--app-diff-removed-bg)] text-[var(--app-diff-removed-text)]' : '',
                    isHunk ? 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)] font-semibold' : '',
                    isHeader ? 'text-[var(--app-hint)] font-semibold' : ''
                ].filter(Boolean).join(' ')

                const style = isAdd
                    ? { borderLeft: '2px solid var(--app-git-staged-color)' }
                    : isRemove
                        ? { borderLeft: '2px solid var(--app-git-deleted-color)' }
                        : undefined

                return (
                    <div key={`${index}-${line}`} className={className} style={style}>
                        {line || ' '}
                    </div>
                )
            })}
        </div>
    )
}

function FileContentSkeleton(props: { label: string }) {
    const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-4/5']

    return (
        <div role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            <div className="animate-pulse space-y-2 rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3">
                {Array.from({ length: 12 }).map((_, index) => (
                    <div key={`file-skeleton-${index}`} className={`h-3 ${widths[index % widths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                ))}
            </div>
        </div>
    )
}

function resolveLanguage(path: string): string | undefined {
    const parts = path.split('.')
    if (parts.length <= 1) return undefined
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return undefined
    return langAlias[ext] ?? ext
}

function resolveImageMimeType(path: string): string | null {
    const parts = path.split('.')
    if (parts.length <= 1) return null
    const ext = parts[parts.length - 1]?.toLowerCase()
    if (!ext) return null
    return IMAGE_MIME_BY_EXTENSION[ext] ?? null
}

function isMarkdownFile(path: string): boolean {
    return /\.(md|markdown|mdx)$/i.test(path)
}

function getUtf8ByteLength(value: string): number {
    return new TextEncoder().encode(value).length
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

function SourceCodeView(props: {
    content: string
    highlighted: ReactNode | null
    canCopyContent: boolean
    copied: boolean
    onCopy: () => void
    copyLabel: string
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

    const copyButton = props.canCopyContent ? (
        <button
            type="button"
            onClick={props.onCopy}
            className="absolute right-2 top-2 z-10 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
            title={props.copyLabel}
        >
            {props.copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </button>
    ) : null

    if (!props.targetLine) {
        return (
            <div className="relative">
                {copyButton}
                <pre className="shiki overflow-auto rounded-md bg-[var(--app-code-bg)] p-3 pr-8 text-xs font-mono">
                    <code>{props.highlighted ?? props.content}</code>
                </pre>
            </div>
        )
    }

    return (
        <div className="relative">
            {copyButton}
            <pre className="overflow-auto rounded-md bg-[var(--app-code-bg)] py-3 pr-8 text-xs font-mono">
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
        </div>
    )
}

function extractCommandError(result: GitCommandResponse | undefined): string | null {
    if (!result) return null
    if (result.success) return null
    return result.error ?? result.stderr ?? 'Failed to load diff'
}

export default function FilePage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { copied: pathCopied, copy: copyPath } = useCopyToClipboard()
    const { copied: contentCopied, copy: copyContent } = useCopyToClipboard()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/file' })
    const search = useSearch({ from: '/sessions/$sessionId/file' })
    const encodedPath = typeof search.path === 'string' ? search.path : ''
    const staged = search.staged
    const targetLine = typeof search.line === 'number' ? search.line : undefined

    const filePath = useMemo(() => decodePath(encodedPath), [encodedPath])
    const fileName = filePath.split('/').pop() || filePath || t('file.page.fallbackName')
    const imageMimeType = useMemo(() => resolveImageMimeType(filePath), [filePath])
    const markdownFile = useMemo(() => isMarkdownFile(filePath), [filePath])

    const diffQuery = useQuery({
        queryKey: queryKeys.gitFileDiff(sessionId, filePath, staged),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.getGitDiffFile(sessionId, filePath, staged)
        },
        enabled: Boolean(api && sessionId && filePath && !imageMimeType)
    })

    const fileQuery = useQuery({
        queryKey: queryKeys.sessionFile(sessionId, filePath),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.readSessionFile(sessionId, filePath)
        },
        enabled: Boolean(api && sessionId && filePath && !imageMimeType)
    })

    const imageBlobQuery = useQuery({
        queryKey: queryKeys.sessionFileBlob(sessionId, filePath),
        queryFn: async () => {
            if (!api || !sessionId || !filePath) {
                throw new Error('Missing session or path')
            }
            return await api.getSessionFileBlob(sessionId, filePath)
        },
        enabled: Boolean(api && sessionId && filePath && imageMimeType)
    })

    const diffContent = diffQuery.data?.success ? (diffQuery.data.stdout ?? '') : ''
    const diffError = extractCommandError(diffQuery.data)
    const diffSuccess = diffQuery.data?.success === true

    const fileContentResult = fileQuery.data
    const decodedContentResult = fileContentResult?.success && fileContentResult.content
        ? decodeBase64(fileContentResult.content)
        : { text: '', ok: true }
    const decodedContent = decodedContentResult.text
    const binaryFile = fileContentResult?.success
        ? !decodedContentResult.ok || isBinaryContent(decodedContent)
        : false
    const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null)

    useEffect(() => {
        if (!imageBlobQuery.data) {
            setImagePreviewUrl(null)
            return
        }

        const url = URL.createObjectURL(imageBlobQuery.data)
        setImagePreviewUrl(url)
        return () => {
            URL.revokeObjectURL(url)
        }
    }, [imageBlobQuery.data])

    const language = useMemo(() => imageMimeType ? undefined : resolveLanguage(filePath), [filePath, imageMimeType])
    const highlighted = useShikiHighlighter(imageMimeType ? '' : decodedContent, language)
    const contentSizeBytes = useMemo(
        () => (decodedContent ? getUtf8ByteLength(decodedContent) : 0),
        [decodedContent]
    )
    const canCopyContent = fileContentResult?.success === true
        && !binaryFile
        && decodedContent.length > 0
        && contentSizeBytes <= MAX_COPYABLE_FILE_BYTES

    const canDownload = imageMimeType
        ? Boolean(imageBlobQuery.data)
        : fileContentResult?.success === true && Boolean(fileContentResult.content)

    const [displayMode, setDisplayMode] = useState<'diff' | 'file'>('file')
    const [markdownMode, setMarkdownMode] = useState<'preview' | 'source'>('preview')

    useEffect(() => {
        const preferFileContent = Boolean(imageMimeType || targetLine || (markdownFile && staged === undefined && search.tab !== 'changes'))
        if (preferFileContent) {
            setDisplayMode('file')
            return
        }
        if (diffSuccess && diffContent) {
            setDisplayMode('diff')
            return
        }
        setDisplayMode('file')
    }, [diffSuccess, diffContent, imageMimeType, markdownFile, search.tab, staged, targetLine])

    useEffect(() => {
        if (!markdownFile) {
            setMarkdownMode('source')
            return
        }
        setMarkdownMode(targetLine ? 'source' : 'preview')
    }, [filePath, markdownFile, targetLine])

    const loading = diffQuery.isLoading || (imageMimeType ? imageBlobQuery.isLoading : fileQuery.isLoading)
    const imageBlobError = imageBlobQuery.error
        ? (imageBlobQuery.error instanceof Error ? imageBlobQuery.error.message : String(imageBlobQuery.error))
        : null
    const fileQueryError = fileQuery.error
        ? (fileQuery.error instanceof Error ? fileQuery.error.message : String(fileQuery.error))
        : null
    const fileError = imageMimeType
        ? imageBlobError
        : fileContentResult && !fileContentResult.success
            ? (fileContentResult.error ?? 'Failed to read file')
            : fileQueryError
    const missingPath = !filePath
    const diffErrorMessage = diffError ? formatDiffError(diffError, t) : null
    const fileErrorMessage = fileError ? formatReadFileError(fileError, t) : null
    const showMarkdownModeTabs = displayMode === 'file'
        && markdownFile
        && fileContentResult?.success === true
        && !binaryFile
        && decodedContent.length > 0

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionDetailHeader
                title={fileName}
                subtitle={filePath || t('file.page.unknownPath')}
                onBack={goBack}
            />

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                    <FileIcon fileName={fileName} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">{filePath || t('file.page.unknownPath')}</span>
                    <button
                        type="button"
                        onClick={() => copyPath(filePath)}
                        className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                        title={t('file.page.copyPath')}
                    >
                        {pathCopied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
                    </button>
                    {canDownload ? (
                        <button
                            type="button"
                            onClick={() => {
                                if (imageMimeType && imageBlobQuery.data) {
                                    triggerBlobDownload(fileName, imageBlobQuery.data)
                                    return
                                }
                                if (fileContentResult?.success && fileContentResult.content) {
                                    triggerBase64Download(fileName, fileContentResult.content, imageMimeType)
                                }
                            }}
                            className="shrink-0 rounded p-1 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                            title={t('file.page.download')}
                        >
                            <DownloadIcon className="h-3.5 w-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>

            {diffContent ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                        <button
                            type="button"
                            onClick={() => setDisplayMode('diff')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === 'diff' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            {t('file.page.tab.diff')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setDisplayMode('file')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${displayMode === 'file' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            {t('file.page.tab.file')}
                        </button>
                    </div>
                </div>
            ) : null}
            {showMarkdownModeTabs ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 flex items-center gap-2 border-b border-[var(--app-divider)]">
                        <button
                            type="button"
                            onClick={() => setMarkdownMode('preview')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${markdownMode === 'preview' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            {t('file.page.tab.preview')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setMarkdownMode('source')}
                            className={`rounded px-3 py-1 text-xs font-semibold ${markdownMode === 'source' ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                        >
                            {t('file.page.tab.source')}
                        </button>
                    </div>
                </div>
            ) : null}

            <div className="app-scroll-y flex-1 min-h-0">
                <div className="mx-auto w-full max-w-content p-4">
                    {diffErrorMessage ? (
                        <div className="mb-3 rounded-md bg-amber-500/10 p-2 text-xs text-[var(--app-hint)]">
                            {diffErrorMessage}
                        </div>
                    ) : null}
                    {missingPath ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.missingPath')}</div>
                    ) : loading ? (
                        <FileContentSkeleton label={t('loading.file')} />
                    ) : fileErrorMessage ? (
                        <div className="text-sm text-[var(--app-hint)]">{fileErrorMessage}</div>
                    ) : displayMode === 'diff' && diffContent ? (
                        <DiffDisplay diffContent={diffContent} />
                    ) : displayMode === 'diff' && diffError ? (
                        <div className="text-sm text-[var(--app-hint)]">{diffErrorMessage}</div>
                    ) : displayMode === 'file' ? (
                        imagePreviewUrl ? (
                            <ImagePreview
                                src={imagePreviewUrl}
                                fileName={fileName}
                                label={t('file.page.imagePreviewAlt', { name: fileName })}
                            />
                        ) : binaryFile ? (
                            <div className="text-sm text-[var(--app-hint)]">
                                {t('file.page.binary')}
                            </div>
                        ) : (
                            decodedContent ? (
                                markdownFile && markdownMode === 'preview' ? (
                                    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-4">
                                        <MarkdownRenderer content={decodedContent} standalone />
                                    </div>
                                ) : (
                                    <SourceCodeView
                                        content={decodedContent}
                                        highlighted={highlighted}
                                        canCopyContent={canCopyContent}
                                        copied={contentCopied}
                                        onCopy={() => copyContent(decodedContent)}
                                        copyLabel={t('file.page.copyContent')}
                                        targetLine={targetLine}
                                    />
                                )
                            ) : (
                                <div className="text-sm text-[var(--app-hint)]">{t('file.page.empty')}</div>
                            )
                        )
                    ) : (
                        <div className="text-sm text-[var(--app-hint)]">{t('file.page.noChanges')}</div>
                    )}
                </div>
            </div>
        </div>
    )
}
