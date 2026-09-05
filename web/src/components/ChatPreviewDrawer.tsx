import type { OpenLocalServiceResponse } from '@hapi/protocol/localServices'
import { ApiError } from '@/api/client'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ChatFilePreview, ChatPreview, ChatUrlPreview } from './ChatPreviewContext'
import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { CodeBlock } from '@/components/CodeBlock'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { queryKeys } from '@/lib/query-keys'
import { decodeBase64 } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'
import { openLocalServiceInTab } from '@/lib/open-local-service'

function ErrorMessage({ message, retry }: { message: string; retry: () => void }) {
    const { t } = useTranslation()
    return <div role="alert" className="chat-sheet-feedback space-y-3">
        <p>{message}</p>
        <button type="button" className="chat-sheet-action chat-sheet-action-secondary" onClick={retry}>{t('localService.retry')}</button>
    </div>
}

function FilePreview({ preview }: { preview: ChatFilePreview }) {
    const { t } = useTranslation()
    const [mode, setMode] = useState<'source' | 'preview' | 'diff'>(preview.diff ? 'diff' : /\.mdx?$/i.test(preview.path) && !preview.line ? 'preview' : 'source')
    const source = preview.source
    const native = source.type === 'native-codex'
    const image = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i.test(preview.path) && !native
    const file = useQuery({
        queryKey: native ? queryKeys.codexSessionFile(source.machineId, source.sessionId, preview.path) : queryKeys.sessionFile(source.sessionId, preview.path),
        queryFn: () => native ? preview.api.readCodexSessionFile(source.sessionId, source.machineId, preview.path) : preview.api.readSessionFile(source.sessionId, preview.path),
        enabled: !image,
    })
    const diff = useQuery({
        queryKey: queryKeys.gitFileDiff(source.sessionId, preview.path, preview.staged),
        queryFn: () => preview.api.getGitDiffFile(source.sessionId, preview.path, preview.staged),
        enabled: !native && mode === 'diff' && !image,
    })
    const blob = useQuery({
        queryKey: queryKeys.sessionFileBlob(source.sessionId, preview.path),
        queryFn: () => preview.api.getSessionFileBlob(source.sessionId, preview.path),
        enabled: image,
    })
    const [imageUrl, setImageUrl] = useState<string>()
    useEffect(() => {
        if (!blob.data) return
        const url = URL.createObjectURL(blob.data)
        setImageUrl(url)
        return () => URL.revokeObjectURL(url)
    }, [blob.data])
    const decoded = decodeBase64(file.data?.content ?? '')
    const lineRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        // Scroll only the drawer body, never the background chat.
        const line = lineRef.current
        const body = line?.closest<HTMLElement>('[data-chat-drawer-body]')
        if (line && body) body.scrollTop += line.getBoundingClientRect().top - body.getBoundingClientRect().top - 16
    }, [file.data, preview.line, mode])
    const query = image ? blob : mode === 'diff' ? diff : file
    if (query.isPending) return <p role="status" className="chat-sheet-feedback">{t('common.loading')}</p>
    if (query.error) return <ErrorMessage message={query.error.message} retry={() => { void query.refetch() }} />
    if (image) return imageUrl ? <img src={imageUrl} alt={preview.path} className="chat-sheet-group mx-auto max-h-[50dvh] max-w-full object-contain p-3" /> : null
    const data = mode === 'diff' ? diff.data : file.data
    const failed = data && !data.success
    return <div className="space-y-3">
        <div className="chat-segmented" role="group" aria-label={t('chatPreview.view')}>
            {(['source', ...(/\.mdx?$/i.test(preview.path) ? ['preview'] as const : []), ...(!native ? ['diff'] as const : [])] as const).map((value) =>
                <button type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)} className="chat-segment">{t(`chatPreview.${value}`)}</button>)}
        </div>
        {failed ? <ErrorMessage message={data.error ?? t('chatPreview.failed')} retry={() => { void query.refetch() }} />
            : mode === 'diff' ? <CodeBlock code={diff.data?.stdout || t('chatPreview.noDiff')} language="diff" />
                : !decoded.ok || decoded.text.includes('\0') ? <p className="chat-sheet-feedback">{t('chatPreview.binary')}</p>
                    : mode === 'preview' ? <MarkdownRenderer content={decoded.text} standalone />
                        : preview.line ? <div className="overflow-x-auto font-mono text-xs leading-6">{decoded.text.split('\n').map((line, index) =>
                            <div key={index} ref={index + 1 === preview.line ? lineRef : undefined} className={index + 1 === preview.line ? 'whitespace-pre bg-[var(--app-subtle-bg)]' : 'whitespace-pre'}><span className="mr-3 inline-block w-9 text-right text-[var(--app-hint)]">{index + 1}</span>{line || ' '}</div>)}</div>
                            : <CodeBlock code={decoded.text} language={preview.path.split('.').pop()} />}
    </div>
}

function UrlPreview({ preview }: { preview: ChatUrlPreview }) {
    const { t } = useTranslation()
    const [localUrl, setLocalUrl] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const pending = useRef<{ preview: ChatUrlPreview; attempt: number; promise: Promise<OpenLocalServiceResponse> } | null>(null)
    useEffect(() => {
        if (!preview.localService) return
        let cancelled = false
        setLocalUrl(null)
        setError(null)
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
            if (!cancelled) setLocalUrl(url.href)
        }).catch((reason: unknown) => {
            if (!cancelled) setError(reason instanceof ApiError
                ? `${reason.message} (HTTP ${reason.status})`
                : reason instanceof Error ? reason.message : t('chatPreview.failed'))
        })
        return () => { cancelled = true }
    }, [preview, attempt, t])
    const url = preview.localService ? localUrl : preview.url
    return <div className="flex h-[60dvh] min-h-0 flex-col gap-3">
        <p className="chat-sheet-caption shrink-0">{t(preview.localService ? 'chatPreview.localServiceHint' : 'chatPreview.frameHint')}</p>
        <a className="chat-sheet-action chat-sheet-action-secondary shrink-0 self-start" href={preview.url} target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (!preview.localService || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
            event.preventDefault()
            if (!openLocalServiceInTab(preview.localService.api, preview.localService.request, {
                title: t('localService.title'), opening: t('localService.opening'), retry: t('localService.retry'), error: (key) => t(key)
            })) window.location.assign(preview.url)
        }}>{t('chatPreview.openExternal')}</a>
        {error ? <ErrorMessage message={error} retry={() => setAttempt((value) => value + 1)} />
            : url ? <iframe title={t('chatPreview.web')} src={url} referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-forms"
            className="min-h-0 w-full flex-1 rounded-xl border border-[var(--app-border)] bg-white" /> : <p role="status" className="chat-sheet-feedback">{t('localService.opening')}</p>}
    </div>
}

export default function ChatPreviewDrawer(props: { preview: ChatPreview; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { preview } = props
    const { t } = useTranslation()
    return <ChatDetailDialog open={props.open} onOpenChange={props.onOpenChange}
        title={preview.type === 'file' ? preview.path : t('chatPreview.web')}
        testId="chat-preview-drawer" desktopClassName="max-w-4xl">
        {preview.type === 'file'
            ? <FilePreview key={JSON.stringify([preview.source, preview.path, preview.line, preview.column, preview.diff])} preview={preview} />
            : <UrlPreview key={preview.url} preview={preview} />}
    </ChatDetailDialog>
}
