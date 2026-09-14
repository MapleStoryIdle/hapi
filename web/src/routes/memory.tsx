import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, FileText, Folder, FolderOpen, RefreshCw, Server } from 'lucide-react'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { OpenVikingPluginDashboard } from '@/components/OpenVikingPluginDashboard'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import type { Machine, OpenVikingContextEntry, OpenVikingStatusResponse } from '@/types/api'

const ROOT_URI = 'viking://'
type SelectedFile = { uri: string; content?: string; error?: string }
type FileViewMode = 'preview' | 'source'

function isMarkdownUri(uri: string): boolean {
    return /\.(?:md|markdown)$/i.test(fileName(uri))
}

function machineLabel(machine: Machine): string {
    return machine.metadata?.host?.trim() || machine.id.slice(0, 8)
}

function fileName(uri: string): string {
    const value = uri.split('/').filter(Boolean).at(-1)
    if (!value) return uri
    try { return decodeURIComponent(value) } catch { return value }
}

function formatSize(size: number | undefined): string | null {
    if (size === undefined) return null
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function ContextEntries(props: {
    entries: OpenVikingContextEntry[]
    entriesByUri: Record<string, OpenVikingContextEntry[]>
    expandedUris: Set<string>
    loadingUris: Set<string>
    directoryErrors: Record<string, string>
    selectedUri?: string
    depth: number
    onToggleDirectory: (uri: string) => void
    onSelectFile: (entry: OpenVikingContextEntry) => void
    loadingLabel: string
}) {
    return <ul className="min-w-0" role={props.depth === 0 ? 'tree' : 'group'}>
        {props.entries.map((entry, index) => {
            const expanded = props.expandedUris.has(entry.uri)
            const children = props.entriesByUri[entry.uri]
            const loading = props.loadingUris.has(entry.uri)
            const error = props.directoryErrors[entry.uri]
            const selected = props.selectedUri === entry.uri
            const size = entry.isDir ? null : formatSize(entry.size)
            return <li key={entry.uri} role="treeitem" aria-expanded={entry.isDir ? expanded : undefined} className={index > 0 && props.depth === 0 ? 'border-t border-[var(--app-divider)]' : undefined}>
                <button
                    type="button"
                    onClick={() => entry.isDir ? props.onToggleDirectory(entry.uri) : props.onSelectFile(entry)}
                    className={`group flex min-h-12 w-full min-w-0 touch-manipulation items-center gap-3 px-3 text-left text-[15px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-link)] active:bg-[var(--app-subtle-bg)] ${selected ? 'bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]' : 'text-[var(--app-fg)]'}`}
                    style={{ paddingLeft: `${props.depth * 20 + 12}px` }}
                    title={entry.uri}
                >
                    {entry.isDir ? <ChevronRight className={`h-4 w-4 shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" /> : <span className="w-4 shrink-0" />}
                    {entry.isDir ? (expanded ? <FolderOpen className="h-5 w-5 shrink-0 text-[var(--app-link)]" aria-hidden="true" /> : <Folder className="h-5 w-5 shrink-0 text-[var(--app-link)]" aria-hidden="true" />) : <FileText className="h-5 w-5 shrink-0 text-[var(--app-hint)] group-active:text-[var(--app-link)]" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {size ? <span className="shrink-0 text-xs tabular-nums text-[var(--app-hint)]">{size}</span> : null}
                    {selected ? <Check className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                </button>
                {entry.isDir && expanded ? <div className="relative before:absolute before:bottom-1 before:left-[30px] before:top-1 before:w-px before:bg-[var(--app-divider)]">
                    {loading ? <div className="min-h-11 px-3 py-3 text-sm text-[var(--app-hint)]" style={{ paddingLeft: `${(props.depth + 1) * 20 + 40}px` }}>{props.loadingLabel}</div> : null}
                    {error ? <div className="mx-3 my-2 rounded-xl bg-[color-mix(in_srgb,var(--app-error)_9%,transparent)] px-3 py-2 text-sm text-[var(--app-error)]" style={{ marginLeft: `${(props.depth + 1) * 20 + 12}px` }}>{error}</div> : null}
                    {children ? <ContextEntries {...props} entries={children} depth={props.depth + 1} /> : null}
                </div> : null}
            </li>
        })}
    </ul>
}

function ContextDirectoryDrawer(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    rootEntries?: OpenVikingContextEntry[]
    rootError?: string
    entriesByUri: Record<string, OpenVikingContextEntry[]>
    expandedUris: Set<string>
    loadingUris: Set<string>
    directoryErrors: Record<string, string>
    selectedUri?: string
    onToggleDirectory: (uri: string) => void
    onSelectFile: (entry: OpenVikingContextEntry) => void
}) {
    const { t } = useTranslation()
    return <BottomDrawer
        open={props.open}
        onOpenChange={props.onOpenChange}
        title={t('openViking.contextDirectory')}
        subtitle={<span className="font-mono text-xs">{ROOT_URI}</span>}
        density="compact"
        fixedHeight
        desktopDialog
        desktopClassName="sm:max-w-xl"
        bodyClassName="px-3 pb-[max(var(--app-safe-area-bottom),0.75rem)]"
        testId="openviking-context-drawer"
    >
        <div className="overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
            {props.loadingUris.has(ROOT_URI) && !props.rootEntries ? <div className="space-y-1 p-2" aria-label={t('openViking.contextLoading')}>{[0, 1, 2, 3].map((item) => <div key={item} className="session-list-skeleton h-12 rounded-xl" />)}</div>
                : props.rootError ? <div className="flex min-h-24 items-center gap-3 px-4 py-4 text-sm text-[var(--app-error)]"><CircleAlert className="h-5 w-5 shrink-0" aria-hidden="true" /><span className="[overflow-wrap:anywhere]">{props.rootError}</span></div>
                    : props.rootEntries && props.rootEntries.length === 0 ? <div className="px-4 py-8 text-center text-sm text-[var(--app-hint)]">{t('openViking.emptyDirectory')}</div>
                        : props.rootEntries ? <ContextEntries entries={props.rootEntries} entriesByUri={props.entriesByUri} expandedUris={props.expandedUris} loadingUris={props.loadingUris} directoryErrors={props.directoryErrors} selectedUri={props.selectedUri} depth={0} onToggleDirectory={props.onToggleDirectory} onSelectFile={props.onSelectFile} loadingLabel={t('openViking.contextLoading')} /> : null}
        </div>
    </BottomDrawer>
}

function LoadingCards({ label }: { label: string }) {
    return <div className="space-y-3" aria-label={label}><div className="session-list-skeleton h-[72px] rounded-[18px]" /><div className="session-list-skeleton h-52 rounded-[18px]" /></div>
}

export default function OpenVikingPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { machineId } = useSearch({ from: '/plugins/openviking' })
    const [status, setStatus] = useState<OpenVikingStatusResponse | null>(null)
    const [statusLoading, setStatusLoading] = useState(false)
    const [entriesByUri, setEntriesByUri] = useState<Record<string, OpenVikingContextEntry[]>>({})
    const [expandedUris, setExpandedUris] = useState<Set<string>>(() => new Set([ROOT_URI]))
    const [loadingUris, setLoadingUris] = useState<Set<string>>(() => new Set())
    const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({})
    const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
    const [fileViewMode, setFileViewMode] = useState<FileViewMode>('preview')
    const [contentLoading, setContentLoading] = useState(false)
    const [directoryOpen, setDirectoryOpen] = useState(false)
    const [copied, setCopied] = useState(false)
    const contextRequestVersion = useRef(0)
    const contentRequestVersion = useRef(0)
    const onlineMachines = useMemo(() => machines.filter((machine) => machine.active), [machines])
    const selectedMachine = useMemo(() => onlineMachines.find((machine) => machine.id === machineId) ?? onlineMachines[0] ?? null, [machineId, onlineMachines])
    const selectedMachineId = selectedMachine?.id ?? null

    const refreshStatus = useCallback(async () => {
        if (!selectedMachineId) { setStatus(null); return }
        setStatus(null)
        setStatusLoading(true)
        try { setStatus(await api.getOpenVikingStatus(selectedMachineId)) }
        catch (error) { setStatus({ ok: false, error: error instanceof Error ? error.message : t('openViking.unavailable') }) }
        finally { setStatusLoading(false) }
    }, [api, selectedMachineId, t])

    const loadDirectory = useCallback(async (uri: string) => {
        if (!selectedMachineId) return
        const requestVersion = contextRequestVersion.current
        setLoadingUris((current) => new Set(current).add(uri))
        setDirectoryErrors((current) => { const next = { ...current }; delete next[uri]; return next })
        try {
            const result = await api.listOpenVikingContext(selectedMachineId, uri)
            if (contextRequestVersion.current !== requestVersion) return
            if (!result.ok) throw new Error(result.error ?? t('openViking.contextLoadFailed'))
            setEntriesByUri((current) => ({ ...current, [uri]: result.entries ?? [] }))
        } catch (error) {
            if (contextRequestVersion.current === requestVersion) setDirectoryErrors((current) => ({ ...current, [uri]: error instanceof Error ? error.message : t('openViking.contextLoadFailed') }))
        } finally {
            if (contextRequestVersion.current === requestVersion) setLoadingUris((current) => { const next = new Set(current); next.delete(uri); return next })
        }
    }, [api, selectedMachineId, t])

    useEffect(() => {
        contextRequestVersion.current += 1
        setEntriesByUri({})
        setExpandedUris(new Set([ROOT_URI]))
        setLoadingUris(new Set())
        setDirectoryErrors({})
        setSelectedFile(null)
        setFileViewMode('preview')
        setContentLoading(false)
        contentRequestVersion.current += 1
    }, [selectedMachineId])
    useEffect(() => { void refreshStatus() }, [refreshStatus])
    useEffect(() => { if (selectedMachineId && status?.ok) void loadDirectory(ROOT_URI) }, [loadDirectory, selectedMachineId, status?.ok])

    const selectMachine = useCallback((nextMachineId: string) => navigate({ to: '/plugins/openviking', search: { machineId: nextMachineId } }), [navigate])
    const toggleDirectory = useCallback((uri: string) => {
        setExpandedUris((current) => { const next = new Set(current); if (next.has(uri)) next.delete(uri); else next.add(uri); return next })
        if (!expandedUris.has(uri) && !entriesByUri[uri] && !loadingUris.has(uri)) void loadDirectory(uri)
    }, [entriesByUri, expandedUris, loadDirectory, loadingUris])
    const selectFile = useCallback(async (entry: OpenVikingContextEntry) => {
        if (!selectedMachineId) return
        setDirectoryOpen(false)
        const contextVersion = contextRequestVersion.current
        const requestVersion = ++contentRequestVersion.current
        setSelectedFile({ uri: entry.uri })
        setFileViewMode(isMarkdownUri(entry.uri) ? 'preview' : 'source')
        setContentLoading(true)
        try {
            const result = await api.readOpenVikingContext(selectedMachineId, entry.uri)
            if (contextRequestVersion.current !== contextVersion || contentRequestVersion.current !== requestVersion) return
            if (!result.ok) throw new Error(result.error ?? t('openViking.contextReadFailed'))
            setSelectedFile({ uri: entry.uri, content: result.content ?? '' })
        } catch (error) {
            if (contextRequestVersion.current === contextVersion && contentRequestVersion.current === requestVersion) setSelectedFile({ uri: entry.uri, error: error instanceof Error ? error.message : t('openViking.contextReadFailed') })
        } finally {
            if (contextRequestVersion.current === contextVersion && contentRequestVersion.current === requestVersion) setContentLoading(false)
        }
    }, [api, selectedMachineId, t])
    const reload = useCallback(() => {
        contextRequestVersion.current += 1
        setEntriesByUri({})
        setExpandedUris(new Set([ROOT_URI]))
        setLoadingUris(new Set())
        setDirectoryErrors({})
        setSelectedFile(null)
        setFileViewMode('preview')
        setContentLoading(false)
        contentRequestVersion.current += 1
        void refreshStatus()
    }, [refreshStatus])
    const copyPath = useCallback(async () => {
        if (!selectedFile) return
        await navigator.clipboard.writeText(selectedFile.uri)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
    }, [selectedFile])

    const subtitle = selectedMachine ? `${machineLabel(selectedMachine)}${status?.version ? ` · v${status.version}` : ''}` : t('openViking.noMachines')
    const rootEntries = entriesByUri[ROOT_URI]
    const rootError = directoryErrors[ROOT_URI]

    return <div className="flex h-full min-h-0 flex-col bg-[var(--app-secondary-bg)] text-[var(--app-fg)]">
        <SessionDetailHeader title="OpenViking" subtitle={subtitle} onBack={() => navigate({ to: '/plugins' })} actions={<>
            <button type="button" className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-40" aria-label={t('openViking.openDirectory')} title={t('openViking.openDirectory')} disabled={!selectedMachine || !status?.ok} aria-expanded={directoryOpen} onClick={() => setDirectoryOpen(true)}><FolderOpen className="h-5 w-5" aria-hidden="true" /></button>
            <button type="button" className="flex h-11 w-11 touch-manipulation items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-40" aria-label={t('openViking.refresh')} title={t('openViking.refresh')} disabled={!selectedMachine || statusLoading} onClick={reload}><RefreshCw className={`h-5 w-5 ${statusLoading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" /></button>
        </>} />
        <main className="app-scroll-y min-h-0 flex-1">
            <div className="mx-auto w-full max-w-content space-y-4 px-3 pb-[max(var(--app-safe-area-bottom),1rem)] pt-3 sm:px-5 sm:pt-5">
                {machinesLoading ? <LoadingCards label={t('openViking.loading')} /> : onlineMachines.length === 0 ? <section className="flex min-h-64 flex-col items-center justify-center rounded-[20px] border border-[var(--app-border)] bg-[var(--app-bg)] px-6 text-center shadow-sm"><span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--app-secondary-bg)] text-[var(--app-hint)]"><Server className="h-7 w-7" aria-hidden="true" /></span><h2 className="text-[17px] font-semibold">{t('openViking.noMachinesTitle')}</h2><p className="mt-1 max-w-sm text-sm leading-5 text-[var(--app-hint)]">{t('openViking.noMachines')}</p></section> : <>
                    <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                        <label className="flex min-h-[58px] items-center gap-3 px-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]"><Server className="h-[18px] w-[18px]" aria-hidden="true" /></span><span className="min-w-0 flex-1 text-[15px] font-medium">{t('openViking.machine')}</span><span className="relative flex min-w-0 max-w-[58%] items-center text-[15px] text-[var(--app-hint)]"><select value={selectedMachine?.id ?? ''} onChange={(event) => selectMachine(event.target.value)} className="h-11 min-w-0 appearance-none truncate bg-transparent py-2 pl-2 pr-7 text-right text-[15px] text-[var(--app-hint)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" aria-label={t('openViking.machine')}>{onlineMachines.map((machine) => <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>)}</select><ChevronDown className="pointer-events-none absolute right-1 h-4 w-4" aria-hidden="true" /></span></label>
                        <div className="ml-[60px] border-t border-[var(--app-divider)]" />
                        <div className="flex min-h-[52px] items-center gap-3 px-4"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${status?.ok ? 'bg-emerald-500' : statusLoading ? 'bg-amber-500 motion-safe:animate-pulse' : 'bg-[var(--app-error)]'}`} /><span className="min-w-0 flex-1 text-[15px]">{status?.ok ? t('openViking.available') : statusLoading ? t('openViking.connecting') : t('openViking.unavailable')}</span>{status?.version ? <span className="text-sm tabular-nums text-[var(--app-hint)]">v{status.version}</span> : null}</div>
                    </section>
                    {statusLoading && !status ? <LoadingCards label={t('openViking.connecting')} /> : status?.ok && selectedMachine ? <OpenVikingPluginDashboard api={api} machineId={selectedMachine.id} files={<>
                        {selectedFile ? <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm"><div className="flex min-h-[68px] items-center gap-3 px-4 py-2.5"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]"><FileText className="h-5 w-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h2 className="truncate text-[16px] font-semibold" title={fileName(selectedFile.uri)}>{fileName(selectedFile.uri)}</h2><p className="truncate font-mono text-xs leading-5 text-[var(--app-hint)]" title={selectedFile.uri}>{selectedFile.uri}</p></div><button type="button" onClick={() => void copyPath()} className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-[var(--app-link)] transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" aria-label={t('openViking.copyPath')} title={t('openViking.copyPath')}>{copied ? <Check className="h-5 w-5" aria-hidden="true" /> : <Copy className="h-5 w-5" aria-hidden="true" />}</button></div></section> : null}
                        <section className="min-h-[min(50dvh,32rem)] overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                            {selectedFile && isMarkdownUri(selectedFile.uri) && !contentLoading && !selectedFile.error ? <div className="border-b border-[var(--app-divider)] px-3 py-2"><div className="grid grid-cols-2 rounded-[10px] bg-[var(--app-secondary-bg)] p-0.5" role="tablist" aria-label={t('openViking.viewMode')}>
                                {(['preview', 'source'] as const).map((mode) => <button key={mode} type="button" role="tab" aria-selected={fileViewMode === mode} onClick={() => setFileViewMode(mode)} className={`min-h-9 rounded-[8px] px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${fileViewMode === mode ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}>{t(`openViking.${mode}`)}</button>)}
                            </div></div> : null}
                            {contentLoading ? <div className="space-y-3 p-4" aria-label={t('openViking.contextLoading')}>{[80, 96, 68, 88, 52].map((width, index) => <div key={index} className="session-list-skeleton h-4 rounded-md" style={{ width: `${width}%` }} />)}</div> : selectedFile?.error ? <div className="flex min-h-64 flex-col items-center justify-center px-6 py-8 text-center"><span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-error)_10%,transparent)] text-[var(--app-error)]"><CircleAlert className="h-6 w-6" aria-hidden="true" /></span><h2 className="text-[17px] font-semibold">{t('openViking.contextReadFailed')}</h2><p className="mt-2 max-w-md [overflow-wrap:anywhere] text-sm leading-5 text-[var(--app-hint)]">{selectedFile.error}</p><button type="button" onClick={() => setDirectoryOpen(true)} className="mt-5 min-h-11 rounded-full bg-[var(--app-link)] px-5 text-[15px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-offset-2">{t('openViking.chooseAnother')}</button></div> : selectedFile ? (isMarkdownUri(selectedFile.uri) && fileViewMode === 'preview' ? <div className="min-h-[min(50dvh,32rem)] overflow-auto p-4 sm:p-5"><MarkdownRenderer content={selectedFile.content ?? ''} standalone /></div> : <pre className="min-h-[min(50dvh,32rem)] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[13px] leading-6 text-[var(--app-fg)] sm:p-5">{selectedFile.content}</pre>) : <div className="flex min-h-64 flex-col items-center justify-center px-6 py-8 text-center"><span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]"><FolderOpen className="h-7 w-7" aria-hidden="true" /></span><h2 className="text-[17px] font-semibold">{t('openViking.selectFileTitle')}</h2><p className="mt-1 max-w-sm text-sm leading-5 text-[var(--app-hint)]">{t('openViking.selectFile')}</p><button type="button" onClick={() => setDirectoryOpen(true)} className="mt-5 min-h-11 rounded-full bg-[var(--app-link)] px-5 text-[15px] font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-offset-2">{t('openViking.openDirectory')}</button></div>}
                        </section>
                    </>} /> : <section className="flex min-h-64 flex-col items-center justify-center rounded-[20px] border border-[var(--app-border)] bg-[var(--app-bg)] px-6 py-8 text-center shadow-sm"><span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-error)_10%,transparent)] text-[var(--app-error)]"><CircleAlert className="h-7 w-7" aria-hidden="true" /></span><h2 className="text-[17px] font-semibold">{t('openViking.unavailable')}</h2><p className="mt-2 max-w-md [overflow-wrap:anywhere] text-sm leading-5 text-[var(--app-hint)]" role="status">{status?.error ?? t('openViking.connecting')}</p><button type="button" onClick={() => void refreshStatus()} className="mt-5 min-h-11 rounded-full bg-[var(--app-link)] px-5 text-[15px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] focus-visible:ring-offset-2">{t('openViking.retry')}</button></section>}
                </>}
            </div>
        </main>
        <ContextDirectoryDrawer open={directoryOpen} onOpenChange={setDirectoryOpen} rootEntries={rootEntries} rootError={rootError} entriesByUri={entriesByUri} expandedUris={expandedUris} loadingUris={loadingUris} directoryErrors={directoryErrors} selectedUri={selectedFile?.uri} onToggleDirectory={toggleDirectory} onSelectFile={(entry) => void selectFile(entry)} />
    </div>
}
