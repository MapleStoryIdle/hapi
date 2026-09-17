import * as Dialog from '@radix-ui/react-dialog'
import { DetailCopyButton } from '@/components/ui/DetailCopyButton'
import { basename, resolveFullPath } from '@/utils/path'
import type { OpenLocalServiceResponse } from '@hapi/protocol/localServices'
import { ApiError, type ApiClient } from '@/api/client'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { useOptionalAppContext } from '@/lib/app-context'
import { useQuery } from '@tanstack/react-query'
import type { ChatFilePreview, ChatPreview, ChatUrlPreview } from './ChatPreviewContext'
import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { CodeBlock } from '@/components/CodeBlock'
import { DiffDisplay } from '@/components/DiffDisplay'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { queryKeys } from '@/lib/query-keys'
import { decodeBase64 } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { localServiceErrorKey } from '@/lib/open-local-service'
import { GlobeIcon } from '@/components/ToolCard/icons'
import { FilePreviewState } from '@/components/FilePreviewState'
import { classifyFilePreviewError, FilePreviewError } from '@/lib/file-preview-error'

const FRAME_LOAD_TIMEOUT_MS = 15_000
const MAX_NATIVE_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_MIME_TYPES: Record<string, string> = {
    apng: 'image/apng', avif: 'image/avif', bmp: 'image/bmp', gif: 'image/gif',
    ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    svg: 'image/svg+xml', webp: 'image/webp'
}
type PageMetadata = { title: string; icon: string | null; readonly?: boolean }


function PublicUrlPreview({ preview, api, onMetadata }: { preview: ChatUrlPreview; api: ApiClient; onMetadata: (metadata: PageMetadata | null) => void }) {
    const { t } = useTranslation()
    const page = useQuery({ queryKey: ['web-reader', preview.url], queryFn: () => api.readWebPage(preview.url), retry: false, staleTime: 60_000, gcTime: 60_000, refetchOnWindowFocus: false, refetchOnReconnect: false })
    useEffect(() => {
        onMetadata(null)
    }, [page.data, onMetadata])
    if (page.isPending) return <p role="status" className="chat-sheet-feedback">{t('loading')}</p>
    if (page.error) return <div className="p-4"><ErrorMessage message={t('chatPreview.readerFailed')} retry={() => { void page.refetch() }} /></div>
    // Also suppress previously cached reader responses during an in-place upgrade.
    if (page.data.mode !== 'embed') return <div role="status" className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-[var(--app-hint)]">{t('chatPreview.blocked')}</div>
    return <UrlPreview preview={preview} onMetadata={onMetadata} />
}

function ErrorMessage({ message, retry }: { message: string; retry: () => void }) {
    const { t } = useTranslation()
    return <div role="alert" className="chat-sheet-feedback space-y-3">
        <p>{message}</p>
        <button type="button" className="chat-sheet-action chat-sheet-action-secondary" onClick={retry}>{t('localService.retry')}</button>
    </div>
}

export function FilePreview({ preview }: { preview: ChatFilePreview }) {
    const { t } = useTranslation()
    const [mode, setMode] = useState<'source' | 'preview' | 'diff'>(preview.diff ? 'diff' : /\.mdx?$/i.test(preview.path) && !preview.line ? 'preview' : 'source')
    const source = preview.source
    const native = source.type === 'native-codex'
    const extension = preview.path.split('.').pop()?.toLowerCase() ?? ''
    const imageType = Object.hasOwn(IMAGE_MIME_TYPES, extension) ? IMAGE_MIME_TYPES[extension] : undefined
    const image = Boolean(imageType)
    const file = useQuery({
        queryKey: native ? queryKeys.codexSessionFile(source.machineId, source.sessionId, preview.path) : queryKeys.sessionFile(source.sessionId, preview.path),
        queryFn: () => native ? preview.api.readCodexSessionFile(source.sessionId, source.machineId, preview.path) : preview.api.readSessionFile(source.sessionId, preview.path),
        enabled: !image && mode !== 'diff',
    })
    const diff = useQuery({
        queryKey: native ? ['native-file-diff', source.machineId, source.sessionId, preview.path, preview.staged] : queryKeys.gitFileDiff(source.sessionId, preview.path, preview.staged),
        queryFn: () => native
            ? preview.api.browseCodexSessionFiles(source.sessionId, source.machineId, { action: 'diff', path: preview.path, staged: preview.staged })
            : preview.api.getGitDiffFile(source.sessionId, preview.path, preview.staged),
        enabled: mode === 'diff' && !image,
    })
    const blob = useQuery({
        queryKey: native
            ? [...queryKeys.codexSessionFile(source.machineId, source.sessionId, preview.path), 'image']
            : queryKeys.sessionFileBlob(source.sessionId, preview.path),
        queryFn: async () => {
            if (!native) return preview.api.getSessionFileBlob(source.sessionId, preview.path)
            const result = await preview.api.readCodexSessionFile(source.sessionId, source.machineId, preview.path)
            if (!result.success) throw new Error(result.error || t('chatPreview.failed'))
            if (!result.content) throw new FilePreviewError('empty')
            // Bound browser decoding/allocation; the existing authenticated read API is unchanged.
            if (result.content.length > Math.ceil(MAX_NATIVE_IMAGE_BYTES / 3) * 4) {
                throw new FilePreviewError('tooLarge')
            }
            let binary: string
            try { binary = atob(result.content) } catch { throw new FilePreviewError('invalid') }
            if (binary.length > MAX_NATIVE_IMAGE_BYTES) throw new FilePreviewError('tooLarge')
            return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: imageType })
        },
        enabled: image,
        gcTime: 0,
    })
    const [imageUrl, setImageUrl] = useState<string>()
    const [imageFailed, setImageFailed] = useState(false)
    useEffect(() => {
        if (!blob.data) return
        const url = URL.createObjectURL(blob.data)
        setImageFailed(false)
        setImageUrl(url)
        return () => URL.revokeObjectURL(url)
    }, [blob.data])
    const decoded = decodeBase64(file.data?.content ?? '')
    const query = image ? blob : mode === 'diff' ? diff : file
    if (query.isPending) return <p role="status" className="chat-sheet-feedback">{t('loading')}</p>
    if (query.error) return <FilePreviewState issue={classifyFilePreviewError(query.error)} busy={query.isFetching} retry={() => { void query.refetch() }} />
    if (imageFailed) return <FilePreviewState issue="invalid" busy={blob.isFetching} retry={() => { setImageFailed(false); void blob.refetch() }} />
    if (image && blob.data?.size === 0) return <FilePreviewState issue="empty" />
    if (image) return imageUrl ? <img src={imageUrl} alt={preview.path} onError={() => setImageFailed(true)} className="chat-sheet-group mx-auto max-h-[50dvh] max-w-full object-contain p-3" /> : null
    const data = mode === 'diff' ? diff.data : file.data
    const failed = data && !data.success
    const modes: Array<'source' | 'preview' | 'diff'> = ['source', ...(/\.mdx?$/i.test(preview.path) ? ['preview'] as const : []), ...(!native || preview.diff ? ['diff'] as const : [])]
    return <div className="space-y-3">
        {modes.length > 1 ? <div className="chat-segmented chat-detail-tabs" role="group" aria-label={t('chatPreview.view')}
            style={{ '--chat-tab-count': modes.length, '--chat-tab-index': modes.indexOf(mode) } as CSSProperties}>
            {modes.map((value) =>
                <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)} className="chat-segment">{t(`chatPreview.${value}`)}</button>)}
        </div> : null}
        {failed ? <FilePreviewState issue={classifyFilePreviewError(data.error)} busy={query.isFetching} retry={() => { void query.refetch() }} />
            : mode === 'diff' ? diff.data?.stdout ? <DiffDisplay diffContent={diff.data.stdout} />
                : <p className="chat-sheet-feedback">{t('chatPreview.noDiff')}</p>
                : !decoded.ok ? <FilePreviewState issue="invalid" retry={() => { void file.refetch() }} />
                    : decoded.text.includes('\0') ? <FilePreviewState issue="unsupported" />
                    : decoded.text.length === 0 ? <FilePreviewState issue="empty" />
                    : mode === 'preview' ? <MarkdownRenderer content={decoded.text} standalone />
                        : <CodeBlock
                            code={decoded.text}
                            language={extension}
                            highlightLine={preview.line}
                        />}
    </div>
}

function UrlPreview({ preview, onMetadata }: { preview: ChatUrlPreview; onMetadata: (metadata: PageMetadata | null) => void }) {
    const { t } = useTranslation()
    const [localUrl, setLocalUrl] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [frameAttempt, setFrameAttempt] = useState(0)
    const [frameState, setFrameState] = useState<'loading' | 'ready' | 'failed'>('loading')
    const pending = useRef<{ preview: ChatUrlPreview; attempt: number; promise: Promise<OpenLocalServiceResponse> } | null>(null)
    const frameRef = useRef<HTMLIFrameElement>(null)
    useEffect(() => {
        if (!preview.localService) return
        let cancelled = false
        setLocalUrl(null)
        setError(null)
        onMetadata(null)
        if (!pending.current || pending.current.preview !== preview || pending.current.attempt !== attempt) {
            pending.current = { preview, attempt, promise: preview.localService.api.openLocalService({
                ...preview.localService.request, presentation: 'embed'
            }) }
        }
        void pending.current.promise.then((result) => {
            const url = new URL(result.url)
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
                || !/^\/(?:preview\/[a-f0-9]{32}\/)?__shapi_local\/embed\/[a-f0-9]{64}\//.test(url.pathname)) {
                throw new Error(t('chatPreview.failed'))
            }
            if (!cancelled) {
                setFrameState('loading')
                setLocalUrl(url.href)
            }
        }).catch((reason: unknown) => {
            if (!cancelled) setError(t(localServiceErrorKey(reason instanceof ApiError ? reason.code : null)))
        })
        return () => { cancelled = true }
    }, [preview, attempt, t, onMetadata])
    useEffect(() => {
        if (!localUrl) return
        const expected = new URL(localUrl)
        const scope = expected.pathname.match(/^\/(?:preview\/[a-f0-9]{32}\/)?__shapi_local\/embed\/[a-f0-9]{64}(?=\/)/)?.[0]
        if (!scope) return
        const receive = (event: MessageEvent<unknown>) => {
            // Opaque frames serialize their origin as null. Origin alone is
            // never authentication: only this exact iframe can update its label.
            if (event.origin !== 'null' || !frameRef.current || event.source !== frameRef.current.contentWindow) return
            const data = event.data
            if (!data || typeof data !== 'object' || !('type' in data) || data.type !== 'shapi:preview-metadata'
                || !('title' in data) || typeof data.title !== 'string' || data.title.length > 200) return
            let icon: string | null = null
            if ('icon' in data && typeof data.icon === 'string' && data.icon.length < 8192) {
                try {
                    const url = new URL(data.icon)
                    if (url.origin === expected.origin && url.pathname.startsWith(scope + '/') && !url.username && !url.password) icon = url.href
                } catch { /* Keep the generic web icon. */ }
            }
            onMetadata({ title: data.title.trim(), icon })
        }
        window.addEventListener('message', receive)
        return () => window.removeEventListener('message', receive)
    }, [localUrl, onMetadata])
    const url = preview.localService ? localUrl : preview.url
    useEffect(() => {
        if (!url || frameState !== 'loading') return
        const timeout = window.setTimeout(() => setFrameState('failed'), FRAME_LOAD_TIMEOUT_MS)
        return () => window.clearTimeout(timeout)
    }, [url, frameAttempt, frameState])
    return <div className="flex h-full min-h-0 flex-1 flex-col">
        {error || frameState === 'failed' ? <div className="p-4"><ErrorMessage message={error ?? t(preview.localService ? 'localService.failed' : 'chatPreview.failed')} retry={() => {
            setFrameState('loading')
            setFrameAttempt((value) => value + 1)
            if (preview.localService) {
                setLocalUrl(null)
                setAttempt((value) => value + 1)
            }
        }} /></div> : url ? <div className="relative min-h-0 flex-1">
            {frameState === 'loading' ? <p role="status" className="chat-sheet-feedback absolute inset-0 z-[1] m-0 flex items-center justify-center">{t('loading')}</p> : null}
            <iframe ref={frameRef} key={`${url}:${frameAttempt}`} title={t('chatPreview.web')} src={url} referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-forms" onLoad={() => setFrameState('ready')} onError={() => setFrameState('failed')}
                className="block h-full min-h-0 w-full border-0 bg-white" />
        </div> : <p role="status" className="chat-sheet-feedback">{t('localService.opening')}</p>}
    </div>
}

export default function ChatPreviewDrawer(props: { preview: ChatPreview; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { preview } = props
    const app = useOptionalAppContext()
    const { t } = useTranslation()
    const [page, setPage] = useState<{ preview: ChatPreview; metadata: PageMetadata } | null>(null)
    const [failedIcon, setFailedIcon] = useState<string | null>(null)
    const metadata = page?.preview === preview ? page.metadata : null
    const onMetadata = useCallback((next: PageMetadata | null) => {
        setPage(next ? { preview, metadata: next } : null)
    }, [preview])
    const pageTitle = preview.type === 'url' ? metadata?.title || preview.localService?.request.url || preview.url : ''
    const pageIcon = metadata?.icon && metadata.icon !== failedIcon ? metadata.icon : null
    return <ChatDetailDialog open={props.open} onOpenChange={props.onOpenChange}
        title={preview.type === 'file' ? basename(preview.path) : pageTitle}
        header={preview.type === 'file' ? (
            <div className="flex min-w-0 items-center gap-1 sm:pr-11">
                <Dialog.Title className="min-w-0 [overflow-wrap:anywhere]">{basename(preview.path)}</Dialog.Title>
                <DetailCopyButton value={resolveFullPath(preview.path, preview.workspacePath)} label={t('file.page.copyPath')} iconOnly />
            </div>
        ) : (
            <div className="flex min-w-0 items-center gap-2 sm:pr-11">
                <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center text-[var(--app-hint)]">
                    {pageIcon ? <img src={pageIcon} alt="" width={20} height={20} referrerPolicy="no-referrer" className="size-5 object-contain" onError={() => setFailedIcon(pageIcon)} /> : <GlobeIcon className="size-5" />}
                </span>
                <Dialog.Title className="min-w-0 truncate" title={pageTitle}>{pageTitle}</Dialog.Title>
                {metadata?.readonly ? <span className="shrink-0 text-xs font-medium text-[var(--app-hint)]">readonly</span> : null}
                {/* Copy the reconnectable launch route, never an expiring embed grant. */}
                <DetailCopyButton value={new URL(preview.url, window.location.href).href} label={t('chatPreview.copyLink')} iconOnly />
            </div>
        )}
        fixedHeight={preview.type === 'url'}
        bodyClassName={preview.type === 'url' ? 'chat-web-preview-body' : undefined}
        testId="chat-preview-drawer" desktopClassName="max-w-4xl">
        {preview.type === 'file'
            ? <FilePreview key={JSON.stringify([preview.source, preview.path, preview.line, preview.column, preview.diff])} preview={preview} />
            : !preview.localService && app?.api
                ? <PublicUrlPreview key={preview.url} preview={preview} api={app.api} onMetadata={onMetadata} />
                : <UrlPreview key={preview.url} preview={preview} onMetadata={onMetadata} />}
    </ChatDetailDialog>
}
