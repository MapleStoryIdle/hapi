import { lazy, Suspense, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Folder, GitBranch, Search } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { LocalServiceSource } from '@hapi/protocol/localServices'
import type { SessionFileBrowserResponse } from '@hapi/protocol/apiTypes'
import type { ChatFilePreview } from '@/components/ChatPreviewContext'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { DetailCopyButton } from '@/components/ui/DetailCopyButton'
import { FileIcon } from '@/components/FileIcon'
import { FilePreviewState } from '@/components/FilePreviewState'
import { classifyFilePreviewError } from '@/lib/file-preview-error'
import { buildGitStatusFiles } from '@/lib/gitParsers'
import { useTranslation } from '@/lib/use-translation'

const FilePreview = lazy(() => import('@/components/ChatPreviewDrawer').then(module => ({ default: module.FilePreview })))

export function SessionFilesDrawer(props: { api: ApiClient; source: LocalServiceSource; cwd: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<'changes' | 'directory'>('changes')
    const [path, setPath] = useState('')
    const [search, setSearch] = useState('')
    const [preview, setPreview] = useState<ChatFilePreview | null>(null)
    const scroll = useRef<HTMLDivElement>(null)
    const positions = useRef(new Map<string, number>())
    const source = props.source
    const key = ['session-files-browser', source]
    const changes = useQuery({
        queryKey: [...key, 'changes'], enabled: props.open && !preview,
        staleTime: 30_000, refetchOnWindowFocus: false, retry: 1,
        queryFn: async (): Promise<SessionFileBrowserResponse> => {
            if (source.type === 'native-codex') {
                const result = await props.api.browseCodexSessionFiles(source.sessionId, source.machineId, { action: 'changes', path: '' })
                if (!result.success) throw new Error(result.error)
                return result
            }
            const status = await props.api.getGitStatus(source.sessionId)
            if (!status.success) {
                if (/not a git repository/i.test(status.error ?? status.stderr ?? '')) return { success: true, isGitRepository: false }
                throw new Error(status.error ?? status.stderr)
            }
            const [unstaged, staged] = await Promise.all([props.api.getGitDiffNumstat(source.sessionId, false), props.api.getGitDiffNumstat(source.sessionId, true)])
            if (!unstaged.success || !staged.success) throw new Error(unstaged.error ?? staged.error ?? 'Git status unavailable')
            return { success: true, isGitRepository: true, status: status.stdout, unstaged: unstaged.stdout, staged: staged.stdout }
        }
    })
    const isGit = changes.data?.isGitRepository
    const activeTab = isGit === false || changes.isError ? 'directory' : tab
    const directory = useQuery({
        queryKey: [...key, 'directory', path], enabled: props.open && !preview && activeTab === 'directory',
        staleTime: 30_000, refetchOnWindowFocus: false, retry: 1,
        queryFn: async (): Promise<SessionFileBrowserResponse> => {
            const result = source.type === 'native-codex'
                ? await props.api.browseCodexSessionFiles(source.sessionId, source.machineId, { action: 'directory', path })
                : await props.api.listSessionDirectory(source.sessionId, path)
            if (!result.success) throw new Error(result.error)
            return result
        }
    })
    const files = changes.data?.isGitRepository ? buildGitStatusFiles(changes.data.status ?? '', changes.data.unstaged ?? '', changes.data.staged ?? '') : null
    const changed = [...files?.stagedFiles ?? [], ...files?.unstagedFiles ?? []]
    const entries = [...directory.data?.entries ?? []].filter(entry => entry.type !== 'other' && entry.name !== '.git')
        .sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name))
    const filter = search.trim().toLocaleLowerCase()
    const currentQuery = activeTab === 'directory' ? directory : changes
    const location = `${activeTab}:${path}:${search}`
    useLayoutEffect(() => {
        if (!props.open || preview || !scroll.current) return
        const element = scroll.current
        element.scrollTop = positions.current.get(location) ?? 0
        return () => { positions.current.set(location, element.scrollTop) }
    }, [location, preview, props.open])
    const openFile = (filePath: string, diff = false, staged = false) => setPreview({ type: 'file', api: props.api, source, path: filePath, workspacePath: props.cwd, diff, staged })
    const changeDirectory = (next: string) => { setPath(next); setSearch('') }
    const navigationPath = !preview && activeTab === 'directory' ? path : ''
    const fullPath = props.cwd.replace(/[\\/]+$/, '') + (navigationPath ? `/${navigationPath}` : '') || '/'
    return <BottomDrawer open={props.open} onOpenChange={props.onOpenChange} title={t('session.title')} fixedHeight desktopDialog density="compact"
        desktopClassName="h-[calc(100dvh-3rem)] max-w-3xl" bodyClassName="file-browser-surface flex min-h-0 flex-col px-4 pb-4 pt-0"
        testId="session-files-drawer"
        header={<div className="relative flex min-h-11 items-center justify-center pl-14 sm:px-11">
            {preview ? <button type="button" className="absolute left-0 flex h-11 w-11 items-center justify-center text-[var(--app-link)]" aria-label={t('fileBrowser.back')} onClick={() => setPreview(null)}><ChevronLeft className="h-5 w-5" /></button> : null}
            <Dialog.Title className="truncate text-base font-semibold">{preview ? preview.path.split('/').pop() : t('session.title')}</Dialog.Title>
        </div>}>
        <div className="flex min-h-11 shrink-0 items-center gap-2 text-sm text-[var(--app-hint)]">
            <Folder className="h-5 w-5 shrink-0" aria-hidden="true" />
            {!preview && activeTab === 'directory' ? <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label={t('fileBrowser.breadcrumbs')} title={fullPath}>
                {['', ...path.split('/').filter(Boolean)].map((part, index, parts) => <button key={index} type="button"
                    aria-current={index === parts.length - 1 ? 'location' : undefined}
                    className={`flex min-h-11 shrink-0 items-center gap-1 px-1 ${index === parts.length - 1 ? 'text-[var(--app-fg)] font-medium' : 'text-[var(--app-link)]'}`}
                    onClick={() => changeDirectory(parts.slice(1, index + 1).join('/'))}>
                    {index > 0 ? <ChevronRight className="h-3 w-3" aria-hidden="true" /> : null}{part || props.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '/'}
                </button>)}
            </nav> : <span className="min-w-0 flex-1 truncate" title={fullPath}>{fullPath}</span>}
            <DetailCopyButton value={fullPath} label={t('terminal.execution.copyDirectory')} iconOnly />
        </div>
        {preview ? <div ref={scroll} className="min-h-0 flex-1 overflow-auto" data-chat-drawer-body><Suspense fallback={<p role="status">{t('loading')}</p>}><FilePreview key={`${preview.path}:${preview.diff}:${preview.staged}`} preview={preview} /></Suspense></div> : <>
            <label className="file-browser-search my-2 flex h-11 shrink-0 items-center gap-2 rounded-xl px-3">
                <Search className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                <input aria-label={t(activeTab === 'directory' ? 'fileBrowser.searchDirectory' : 'fileBrowser.searchChanges')} placeholder={t(activeTab === 'directory' ? 'fileBrowser.searchDirectory' : 'fileBrowser.searchChanges')} value={search} onChange={event => setSearch(event.target.value)} className="min-w-0 flex-1 bg-transparent text-base outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" />
            </label>
            {isGit === true ? <div className="chat-segmented chat-detail-tabs mb-3 shrink-0" role="group" aria-label={t('chatPreview.view')} style={{ '--chat-tab-count': 2, '--chat-tab-index': activeTab === 'changes' ? 0 : 1 } as CSSProperties}>
                <button type="button" className="chat-segment" aria-pressed={activeTab === 'changes'} onClick={() => { setTab('changes'); setSearch('') }}>{t('files.tab.changes')}{files ? ` ${new Set(changed.map(file => file.fullPath)).size}` : ''}</button>
                <button type="button" className="chat-segment" aria-pressed={activeTab === 'directory'} onClick={() => { setTab('directory'); setSearch('') }}>{t('files.tab.directories')}</button>
            </div> : null}
            {activeTab === 'changes' && isGit === true && files ? <section className="mb-3 shrink-0 text-sm" aria-label="Git">
                <div className="flex min-w-0 items-center gap-2"><GitBranch className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                    <span className="min-w-0 truncate font-semibold" title={files.branch || t('files.branch.detached')}>{files.branch || t('files.branch.detached')}</span>
                </div>
                <p className="mt-1 text-xs text-[var(--app-hint)]">{t('files.branch.summary', { staged: files.totalStaged, unstaged: files.totalUnstaged })}</p>
            </section> : null}
            <div ref={scroll} className="min-h-0 flex-1 overflow-auto">
                {currentQuery.isPending ? <p className="p-4 text-sm text-[var(--app-hint)]" role="status">{t('loading')}</p>
                    : currentQuery.error ? <FilePreviewState issue={classifyFilePreviewError(currentQuery.error)} retry={() => { void currentQuery.refetch() }} />
                    : <div className="file-browser-group">
                        {activeTab === 'directory' ? entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter)).map(entry => <button key={entry.name} type="button" className="file-browser-row" onClick={() => {
                            const next = [path, entry.name].filter(Boolean).join('/')
                            if (entry.type === 'directory') changeDirectory(next); else openFile(next)
                        }}>
                            {entry.type === 'directory' ? <Folder className="h-5 w-5 shrink-0 text-[var(--app-link)]" aria-hidden="true" /> : <FileIcon fileName={entry.name} size={20} />}
                            <span className="min-w-0 flex-1"><span className="block truncate">{entry.name}</span>{entry.type === 'file' && entry.size !== undefined ? <span className="block text-xs text-[var(--app-hint)]">{entry.size < 1024 ? `${entry.size} B` : entry.size < 1024 * 1024 ? `${(entry.size / 1024).toFixed(1)} KB` : `${(entry.size / (1024 * 1024)).toFixed(1)} MB`}</span> : null}</span><ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                        </button>) : changed.filter(file => file.fullPath.toLocaleLowerCase().includes(filter)).map(file => <button type="button" className="file-browser-row" key={`${file.isStaged}:${file.fullPath}`} onClick={() => openFile(file.fullPath, file.status !== 'untracked', file.isStaged)}>
                            <FileIcon fileName={file.fileName} size={20} /><span className="min-w-0 flex-1"><span className="block truncate">{file.fileName}</span><span className="block truncate text-xs text-[var(--app-hint)]">{file.filePath ? `${file.filePath} · ` : ''}{t(file.isStaged ? 'fileBrowser.staged' : 'fileBrowser.unstaged')}</span></span>
                            {file.status === 'untracked' ? <span className="text-xs text-[var(--app-hint)]">{t('fileBrowser.untracked')}</span> : <span className="shrink-0 text-xs tabular-nums"><span className="text-green-600">+{file.linesAdded}</span> <span className="text-red-600">−{file.linesRemoved}</span></span>}<ChevronRight className="h-4 w-4 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                        </button>)}
                        {(activeTab === 'directory' ? entries.filter(entry => entry.name.toLocaleLowerCase().includes(filter)) : changed.filter(file => file.fullPath.toLocaleLowerCase().includes(filter))).length === 0 ? <p className="p-6 text-center text-sm text-[var(--app-hint)]">{t(filter ? 'files.search.empty' : activeTab === 'directory' ? 'files.directories.empty' : 'fileBrowser.noChanges')}</p> : null}
                    </div>}
                {directory.data?.truncated && activeTab === 'directory' ? <p className="p-3 text-xs text-[var(--app-hint)]">{t('fileBrowser.truncated')}</p> : null}
            </div>
        </>}
    </BottomDrawer>
}
