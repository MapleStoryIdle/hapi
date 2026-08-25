import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import { CloseIcon } from '@/components/icons'
import type { Machine, OpenVikingContextEntry, OpenVikingStatusResponse } from '@/types/api'

const ROOT_URI = 'viking://'

type SelectedFile = {
    uri: string
    content?: string
    error?: string
}

function RefreshIcon() {
    return (
        <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 4v6h-6" />
        </svg>
    )
}

function FolderIcon({ open }: { open: boolean }) {
    return (
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            {open ? <path d="M3 7.5h6l2 2h10l-2.5 9.5H5.25L3 7.5Z" /> : <path d="M3 6.5h6l2 2h10v10H3v-12Z" />}
        </svg>
    )
}

function FileIcon() {
    return (
        <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M6 3h8l4 4v14H6z" />
            <path d="M14 3v5h5" />
        </svg>
    )
}

function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m9 18 6-6-6-6" />
        </svg>
    )
}

function machineLabel(machine: Machine): string {
    return machine.metadata?.host?.trim() || machine.id.slice(0, 8)
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
    return (
        <ul className="min-w-0" role={props.depth === 0 ? 'tree' : 'group'}>
            {props.entries.map((entry) => {
                const expanded = props.expandedUris.has(entry.uri)
                const childEntries = props.entriesByUri[entry.uri]
                const loading = props.loadingUris.has(entry.uri)
                const error = props.directoryErrors[entry.uri]
                const size = entry.isDir ? null : formatSize(entry.size)
                return (
                    <li key={entry.uri} role="treeitem" aria-expanded={entry.isDir ? expanded : undefined}>
                        <button
                            type="button"
                            onClick={() => entry.isDir ? props.onToggleDirectory(entry.uri) : props.onSelectFile(entry)}
                            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] ${
                                props.selectedUri === entry.uri
                                    ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)]'
                                    : 'text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'
                            }`}
                            style={{ paddingLeft: `${props.depth * 16 + 8}px` }}
                            title={entry.uri}
                        >
                            {entry.isDir ? <ChevronIcon open={expanded} /> : <span className="w-3.5 shrink-0" />}
                            {entry.isDir ? <FolderIcon open={expanded} /> : <FileIcon />}
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {size ? <span className="shrink-0 text-xs text-[var(--app-hint)]">{size}</span> : null}
                        </button>
                        {entry.isDir && expanded ? (
                            <div>
                                {loading ? (
                                    <div className="px-2 py-1.5 text-xs text-[var(--app-hint)]" style={{ paddingLeft: `${(props.depth + 1) * 16 + 8}px` }}>
                                        {props.loadingLabel}
                                    </div>
                                ) : null}
                                {error ? (
                                    <div className="px-2 py-1.5 text-xs text-[var(--app-error)]" style={{ paddingLeft: `${(props.depth + 1) * 16 + 8}px` }}>
                                        {error}
                                    </div>
                                ) : null}
                                {childEntries ? (
                                    <ContextEntries
                                        {...props}
                                        entries={childEntries}
                                        depth={props.depth + 1}
                                    />
                                ) : null}
                            </div>
                        ) : null}
                    </li>
                )
            })}
        </ul>
    )
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

    return (
        <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/35" />
                <Dialog.Content
                    aria-describedby={undefined}
                    data-testid="openviking-context-drawer"
                    className="fixed inset-y-0 left-0 z-[61] flex w-[min(88vw,28rem)] flex-col overflow-hidden border-r border-[var(--app-border)] bg-[var(--app-dialog-bg)] pt-[var(--app-safe-area-top)] pb-[var(--app-safe-area-bottom)] shadow-[18px_0_48px_rgba(15,23,42,0.2)] outline-none sm:w-[min(28rem,42vw)]"
                >
                    <header className="flex shrink-0 items-start gap-3 border-b border-[var(--app-border)] px-4 py-3 sm:px-5">
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="text-base font-bold text-[var(--app-fg)]">
                                {t('openViking.contextDirectory')}
                            </Dialog.Title>
                            <div className="truncate font-mono text-xs leading-5 text-[var(--app-hint)]">{ROOT_URI}</div>
                        </div>
                        <Dialog.Close
                            type="button"
                            aria-label={t('openViking.closeDirectory')}
                            title={t('openViking.closeDirectory')}
                            className="touch-manipulation -mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </Dialog.Close>
                    </header>
                    <div className="min-h-0 flex-1 overflow-auto py-2">
                        {props.loadingUris.has(ROOT_URI) && !props.rootEntries ? (
                            <div className="px-4 py-3 text-sm text-[var(--app-hint)]">{t('openViking.contextLoading')}</div>
                        ) : props.rootError ? (
                            <div className="px-4 py-3 text-sm text-[var(--app-error)]">{props.rootError}</div>
                        ) : props.rootEntries && props.rootEntries.length === 0 ? (
                            <div className="px-4 py-3 text-sm text-[var(--app-hint)]">{t('openViking.emptyDirectory')}</div>
                        ) : props.rootEntries ? (
                            <ContextEntries
                                entries={props.rootEntries}
                                entriesByUri={props.entriesByUri}
                                expandedUris={props.expandedUris}
                                loadingUris={props.loadingUris}
                                directoryErrors={props.directoryErrors}
                                selectedUri={props.selectedUri}
                                depth={0}
                                onToggleDirectory={props.onToggleDirectory}
                                onSelectFile={props.onSelectFile}
                                loadingLabel={t('openViking.contextLoading')}
                            />
                        ) : null}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}

export default function OpenVikingPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { machineId } = useSearch({ from: '/memory' })
    const [status, setStatus] = useState<OpenVikingStatusResponse | null>(null)
    const [statusLoading, setStatusLoading] = useState(false)
    const [entriesByUri, setEntriesByUri] = useState<Record<string, OpenVikingContextEntry[]>>({})
    const [expandedUris, setExpandedUris] = useState<Set<string>>(() => new Set([ROOT_URI]))
    const [loadingUris, setLoadingUris] = useState<Set<string>>(() => new Set())
    const [directoryErrors, setDirectoryErrors] = useState<Record<string, string>>({})
    const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null)
    const [contentLoading, setContentLoading] = useState(false)
    const [directoryOpen, setDirectoryOpen] = useState(true)
    const contextRequestVersion = useRef(0)
    const contentRequestVersion = useRef(0)

    const onlineMachines = useMemo(
        () => machines.filter((machine) => machine.active),
        [machines]
    )
    const selectedMachine = useMemo(
        () => onlineMachines.find((machine) => machine.id === machineId) ?? onlineMachines[0] ?? null,
        [machineId, onlineMachines]
    )

    const refreshStatus = useCallback(async () => {
        if (!selectedMachine) {
            setStatus(null)
            return
        }

        setStatus(null)
        setStatusLoading(true)
        try {
            const nextStatus = await api.getOpenVikingStatus(selectedMachine.id)
            setStatus(nextStatus)
        } catch (error) {
            setStatus({
                ok: false,
                error: error instanceof Error ? error.message : t('openViking.unavailable')
            })
        } finally {
            setStatusLoading(false)
        }
    }, [api, selectedMachine, t])

    const loadDirectory = useCallback(async (uri: string) => {
        if (!selectedMachine) return
        const requestVersion = contextRequestVersion.current
        setLoadingUris((current) => new Set(current).add(uri))
        setDirectoryErrors((current) => {
            const next = { ...current }
            delete next[uri]
            return next
        })

        try {
            const result = await api.listOpenVikingContext(selectedMachine.id, uri)
            if (contextRequestVersion.current !== requestVersion) return
            if (!result.ok) {
                throw new Error(result.error ?? t('openViking.contextLoadFailed'))
            }
            setEntriesByUri((current) => ({ ...current, [uri]: result.entries ?? [] }))
        } catch (error) {
            if (contextRequestVersion.current !== requestVersion) return
            setDirectoryErrors((current) => ({
                ...current,
                [uri]: error instanceof Error ? error.message : t('openViking.contextLoadFailed')
            }))
        } finally {
            if (contextRequestVersion.current === requestVersion) {
                setLoadingUris((current) => {
                    const next = new Set(current)
                    next.delete(uri)
                    return next
                })
            }
        }
    }, [api, selectedMachine, t])

    useEffect(() => {
        contextRequestVersion.current += 1
        setEntriesByUri({})
        setExpandedUris(new Set([ROOT_URI]))
        setLoadingUris(new Set())
        setDirectoryErrors({})
        setSelectedFile(null)
        setContentLoading(false)
        contentRequestVersion.current += 1
    }, [selectedMachine?.id])

    useEffect(() => {
        void refreshStatus()
    }, [refreshStatus])

    useEffect(() => {
        if (!selectedMachine || !status?.ok) return
        void loadDirectory(ROOT_URI)
    }, [loadDirectory, selectedMachine, status?.ok])

    const selectMachine = useCallback((nextMachineId: string) => {
        navigate({
            to: '/memory',
            search: { machineId: nextMachineId }
        })
    }, [navigate])

    const toggleDirectory = useCallback((uri: string) => {
        setExpandedUris((current) => {
            const next = new Set(current)
            if (next.has(uri)) {
                next.delete(uri)
            } else {
                next.add(uri)
            }
            return next
        })
        if (!expandedUris.has(uri) && !entriesByUri[uri] && !loadingUris.has(uri)) {
            void loadDirectory(uri)
        }
    }, [entriesByUri, expandedUris, loadDirectory, loadingUris])

    const selectFile = useCallback(async (entry: OpenVikingContextEntry) => {
        if (!selectedMachine) return
        const contextVersion = contextRequestVersion.current
        const requestVersion = contentRequestVersion.current + 1
        contentRequestVersion.current = requestVersion
        setSelectedFile({ uri: entry.uri })
        setContentLoading(true)
        try {
            const result = await api.readOpenVikingContext(selectedMachine.id, entry.uri)
            if (contextRequestVersion.current !== contextVersion || contentRequestVersion.current !== requestVersion) return
            if (!result.ok) {
                throw new Error(result.error ?? t('openViking.contextReadFailed'))
            }
            setSelectedFile({ uri: entry.uri, content: result.content ?? '' })
        } catch (error) {
            if (contextRequestVersion.current !== contextVersion || contentRequestVersion.current !== requestVersion) return
            setSelectedFile({
                uri: entry.uri,
                error: error instanceof Error ? error.message : t('openViking.contextReadFailed')
            })
        } finally {
            if (contextRequestVersion.current === contextVersion && contentRequestVersion.current === requestVersion) {
                setContentLoading(false)
            }
        }
    }, [api, selectedMachine, t])

    const reload = useCallback(() => {
        contextRequestVersion.current += 1
        setEntriesByUri({})
        setExpandedUris(new Set([ROOT_URI]))
        setLoadingUris(new Set())
        setDirectoryErrors({})
        setSelectedFile(null)
        setContentLoading(false)
        contentRequestVersion.current += 1
        void refreshStatus()
    }, [refreshStatus])

    const subtitle = selectedMachine
        ? `${machineLabel(selectedMachine)}${status?.version ? ` · v${status.version}` : ''}`
        : t('openViking.noMachines')
    const rootEntries = entriesByUri[ROOT_URI]
    const rootError = directoryErrors[ROOT_URI]

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <SessionDetailHeader
                title={t('openViking.title')}
                subtitle={subtitle}
                onBack={() => navigate({ to: '/sessions' })}
                actions={(
                    <>
                        <button
                            type="button"
                            className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={t('openViking.openDirectory')}
                            title={t('openViking.openDirectory')}
                            disabled={!selectedMachine || !status?.ok}
                            aria-expanded={directoryOpen}
                            onClick={() => setDirectoryOpen(true)}
                        >
                            <FolderIcon open={false} />
                        </button>
                        <button
                            type="button"
                            className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={t('openViking.refresh')}
                            title={t('openViking.refresh')}
                            disabled={!selectedMachine || statusLoading}
                            onClick={reload}
                        >
                            <RefreshIcon />
                        </button>
                    </>
                )}
            />
            {machinesLoading ? (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                    {t('openViking.loading')}
                </div>
            ) : onlineMachines.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                    {t('openViking.noMachines')}
                </div>
            ) : (
                <>
                    <div className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                        <label className="mx-auto flex w-full max-w-content items-center gap-3 text-sm text-[var(--app-hint)]">
                            <span className="shrink-0">{t('openViking.machine')}</span>
                            <select
                                value={selectedMachine?.id ?? ''}
                                onChange={(event) => selectMachine(event.target.value)}
                                className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2 text-sm text-[var(--app-fg)] outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                                aria-label={t('openViking.machine')}
                            >
                                {onlineMachines.map((machine) => (
                                    <option key={machine.id} value={machine.id}>{machineLabel(machine)}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                    {statusLoading && !status ? (
                        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                            {t('openViking.connecting')}
                        </div>
                    ) : status?.ok ? (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
                                <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-3">
                                    <div className="min-w-0">
                                        <div className="text-sm font-semibold text-[var(--app-fg)]">{t('openViking.contentPreview')}</div>
                                        {selectedFile ? (
                                            <div className="truncate font-mono text-xs text-[var(--app-hint)]" title={selectedFile.uri}>{selectedFile.uri}</div>
                                        ) : null}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setDirectoryOpen(true)}
                                        className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                        aria-label={t('openViking.openDirectory')}
                                    >
                                        <FolderIcon open={false} />
                                        <span className="hidden sm:inline">{t('openViking.openDirectory')}</span>
                                    </button>
                                </div>
                                {contentLoading ? (
                                    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                                        {t('openViking.contextLoading')}
                                    </div>
                                ) : selectedFile?.error ? (
                                    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-error)]">
                                        {selectedFile.error}
                                    </div>
                                ) : selectedFile ? (
                                    <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-[var(--app-fg)]">
                                        {selectedFile.content}
                                    </pre>
                                ) : (
                                    <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-[var(--app-hint)]">
                                        {t('openViking.selectFile')}
                                    </div>
                                )}
                            </section>
                            <ContextDirectoryDrawer
                                open={directoryOpen}
                                onOpenChange={setDirectoryOpen}
                                rootEntries={rootEntries}
                                rootError={rootError}
                                entriesByUri={entriesByUri}
                                expandedUris={expandedUris}
                                loadingUris={loadingUris}
                                directoryErrors={directoryErrors}
                                selectedUri={selectedFile?.uri}
                                onToggleDirectory={toggleDirectory}
                                onSelectFile={(entry) => void selectFile(entry)}
                            />
                        </div>
                    ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                            <div className="text-sm font-medium text-[var(--app-fg)]">{t('openViking.unavailable')}</div>
                            <div className="max-w-md text-sm text-[var(--app-hint)]" role="status">
                                {status?.error ?? t('openViking.connecting')}
                            </div>
                            <button
                                type="button"
                                onClick={() => void refreshStatus()}
                                className="rounded-lg bg-[var(--app-button)] px-4 py-2 text-sm font-medium text-[var(--app-button-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            >
                                {t('openViking.retry')}
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}
