import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
    Navigate,
    Outlet,
    createRootRoute,
    createRoute,
    createRouter,
    useLocation,
    useMatchRoute,
    useNavigate,
    useParams,
    useSearch,
} from '@tanstack/react-router'
import { getScrollRestorationKey } from '@/lib/scrollRestorationKey'
import { App } from '@/App'
import { CodexSessionSyncDialog } from '@/components/CodexSessionSyncDialog'
import { RecentCodexSessions } from '@/components/RecentCodexSessions'
import { CodexSessionContextPage } from '@/components/CodexSessionContextPage'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { LoadingState } from '@/components/LoadingState'
import { SessionEntryLoading } from '@/components/SessionEntryLoading'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { isTelegramApp } from '@/hooks/useTelegram'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import { useMessages } from '@/hooks/queries/useMessages'
import { useMachines } from '@/hooks/queries/useMachines'
import { useSession } from '@/hooks/queries/useSession'
import { useSessions } from '@/hooks/queries/useSessions'
import { useSlashCommands } from '@/hooks/queries/useSlashCommands'
import { useSkills } from '@/hooks/queries/useSkills'
import { useSendMessage, type SendErrorInfo } from '@/hooks/mutations/useSendMessage'
import { useSpawnSession } from '@/hooks/mutations/useSpawnSession'
import { ApiError } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'
import { useToast } from '@/lib/toast-context'
import { useTranslation } from '@/lib/use-translation'
import { fetchLatestMessages, seedMessageWindowFromSession } from '@/lib/message-window-store'
import { clearDraftsAfterSend } from '@/lib/clearDraftsAfterSend'
import { inactiveSessionCanResume } from '@/lib/sessionResume'
import { markSessionSeen } from '@/lib/sessionLastSeen'
import { clearCodexImportedSession, markCodexSessionsImported } from '@/lib/codexImportedSessions'
import type { Machine, CodexDuplicateSessionGroup, CodexLocalSessionSummary, SessionSummary } from '@/types/api'
import { setSharePendingTransfer } from '@/lib/sharePendingState'
import { deleteShareTransfer } from '@/lib/shareTransfer'
import { presentMachineHealth, formatMachineUptimeSeconds } from '@/lib/machineHealth'
import { getLanNetworkInterfaces } from '@/lib/networkInterfaces'
import { loadDefaultNewSessionAgentConfig } from '@/components/NewSession/preferences'

const SessionChat = lazy(() => import('@/components/SessionChat').then((module) => ({ default: module.SessionChat })))
const NewSession = lazy(() => import('@/components/NewSession').then((module) => ({ default: module.NewSession })))
const WorkspaceBrowser = lazy(() => import('@/components/WorkspaceBrowser').then((module) => ({ default: module.WorkspaceBrowser })))
const FilesPage = lazy(() => import('@/routes/sessions/files'))
const FilePage = lazy(() => import('@/routes/sessions/file'))
const CodexFilePage = lazy(() => import('@/routes/sessions/codex-file'))
const TerminalPage = lazy(() => import('@/routes/sessions/terminal'))
const OpenVikingPage = lazy(() => import('@/routes/memory'))
const SettingsPage = lazy(() => import('@/routes/settings'))
const SharePage = lazy(() => import('@/routes/share'))
const SharesPage = lazy(() => import('@/routes/shares'))

type ComposerSendError = {
    id: number
    text: string
    message: string
    scheduledAt: number | null
    action?: {
        label: string
        onClick: () => void
        pending?: boolean
    } | null
}

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function CodexImportIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            {/* 中文注释：入口图标改成纯更新箭头，弱化“聊天”含义，避免用户误解成会话本身而不是导入动作。 */}
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    )
}

function SettingsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function RecentSessionsIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 7v5l3 2" />
        </svg>
    )
}

function LaptopIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <rect x="5" y="5" width="14" height="10" rx="1.5" />
            <path d="M3 19h18" />
            <path d="m7 15-1.5 4" />
            <path d="m17 15 1.5 4" />
        </svg>
    )
}

function SwitchWorkspaceIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M7 7h11" />
            <path d="m15 4 3 3-3 3" />
            <path d="M17 17H6" />
            <path d="m9 14-3 3 3 3" />
        </svg>
    )
}


function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

const SELECTED_RUNNER_STORAGE_KEY = 'hapi:selectedRunnerMachineId'

function loadSelectedRunnerMachineId(): string | null {
    try {
        return localStorage.getItem(SELECTED_RUNNER_STORAGE_KEY)
    } catch {
        return null
    }
}

function saveSelectedRunnerMachineId(machineId: string): void {
    try {
        localStorage.setItem(SELECTED_RUNNER_STORAGE_KEY, machineId)
    } catch {
        // Ignore storage failures; selection still works for this render tree.
    }
}

function getSessionsForMachine(sessions: SessionSummary[], machineId: string | null | undefined): SessionSummary[] {
    if (!machineId) return sessions
    return sessions.filter((session) => session.metadata?.machineId === machineId)
}

function formatBytes(value: number | null | undefined): string {
    if (!Number.isFinite(value ?? NaN) || value === undefined || value === null) {
        return '—'
    }
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let scaled = value
    let unitIndex = 0
    while (scaled >= 1024 && unitIndex < units.length - 1) {
        scaled /= 1024
        unitIndex += 1
    }
    const digits = scaled >= 10 || unitIndex === 0 ? 0 : 1
    return `${scaled.toFixed(digits)} ${units[unitIndex]}`
}

function formatRunnerTime(value: number | null | undefined): string | null {
    if (!value) return null
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString()
}

function RunnerMetricCard(props: { label: string; value: string; detail?: string; tone?: 'default' | 'ok' | 'warn' }) {
    const toneClass = props.tone === 'ok'
        ? 'text-green-600 dark:text-green-400'
        : props.tone === 'warn'
            ? 'text-orange-600 dark:text-orange-400'
            : 'text-[var(--app-fg)]'
    return (
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
            <div className="text-[11px] font-medium text-[var(--app-hint)]">{props.label}</div>
            <div className={`mt-1 text-base font-semibold leading-5 ${toneClass}`}>{props.value}</div>
            {props.detail ? <div className="mt-0.5 truncate text-[11px] text-[var(--app-hint)]" title={props.detail}>{props.detail}</div> : null}
        </div>
    )
}

function RunnerDetailsPanel(props: { machine: Machine }) {
    const machine = props.machine
    const health = machine.health ?? null
    const presentation = presentMachineHealth(health, machine.metadata?.platform)
    const cpuMetric = presentation?.metrics.find((metric) => metric.id === 'cpu')
    const ramMetric = presentation?.metrics.find((metric) => metric.id === 'ram')
    const diskMetric = presentation?.metrics.find((metric) => metric.id === 'disk')
    const diskDetail = health?.disk
        ? `${formatBytes(health.disk.freeBytes)} free / ${formatBytes(health.disk.totalBytes)}`
        : undefined
    const networkList = getLanNetworkInterfaces(health?.networkInterfaces)
    const cliList = health?.agentCli ?? []
    const runnerStartedAt = formatRunnerTime(machine.runnerState?.startedAt)
    const lastSeenAt = formatRunnerTime(machine.activeAt)
    const uptimeText = health?.uptimeSeconds !== undefined ? formatMachineUptimeSeconds(health.uptimeSeconds) : null

    return (
        <div role="dialog" aria-label="Runner 状态" className="absolute left-1/2 top-full z-50 mt-3 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-left shadow-[0_20px_60px_rgba(15,23,42,0.20)]">
            <div className="flex items-start gap-3 px-1 pb-3">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${machine.active ? 'bg-[#22c55e]' : 'bg-[#a3a3a3]'}`} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <div className="truncate text-base font-semibold text-[var(--app-fg)]">{getMachineTitle(machine)}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]" title={machine.id}>{machine.id}</div>
                </div>
                <div className="rounded-full border border-[var(--app-border)] px-2 py-1 text-[11px] font-medium text-[var(--app-hint)]">
                    {machine.runnerState?.status ?? (machine.active ? 'online' : 'offline')}
                </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
                <RunnerMetricCard label="CPU" value={cpuMetric ? `${cpuMetric.percent}%` : '—'} detail={presentation?.loadDetail ? `load ${presentation.loadDetail}` : undefined} />
                <RunnerMetricCard label="内存" value={ramMetric ? `${ramMetric.percent}%` : '—'} />
                <RunnerMetricCard label="磁盘" value={diskMetric ? `${diskMetric.percent}%` : '—'} detail={diskDetail} />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                    <div className="font-medium text-[var(--app-hint)]">Runner</div>
                    <div className="mt-1 space-y-1 text-[var(--app-fg)]">
                        <div>PID: {machine.runnerState?.pid ?? '—'}</div>
                        <div>端口: {machine.runnerState?.httpPort ?? '—'}</div>
                        <div>运行: {uptimeText ?? '—'}</div>
                    </div>
                </div>
                <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                    <div className="font-medium text-[var(--app-hint)]">系统</div>
                    <div className="mt-1 space-y-1 text-[var(--app-fg)]">
                        <div>{machine.metadata?.platform ?? 'unknown'}</div>
                        <div>HAPI {machine.metadata?.happyCliVersion ?? '—'}</div>
                        <div title={lastSeenAt ?? undefined}>心跳: {lastSeenAt ?? '—'}</div>
                    </div>
                </div>
            </div>

            <div className="mt-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-[var(--app-hint)]">局域网 IP</div>
                    <div className="text-[11px] text-[var(--app-hint)]">{networkList.length > 0 ? `${networkList.length} 个地址` : '暂无数据'}</div>
                </div>
                {networkList.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                        {networkList.map((item) => (
                            <span key={`${item.name}-${item.address}`} className="rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] text-[var(--app-fg)]">
                                {item.name} · {item.address}
                            </span>
                        ))}
                    </div>
                ) : <div className="text-xs text-[var(--app-hint)]">未发现可直接访问的局域网 IPv4。</div>}
            </div>

            <div className="mt-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
                <div className="mb-2 text-xs font-medium text-[var(--app-hint)]">Agent CLI</div>
                {cliList.length > 0 ? (
                    <div className="grid grid-cols-2 gap-1.5">
                        {cliList.map((cli) => (
                            <div key={cli.id} className="flex items-center justify-between gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5">
                                <span className="truncate text-xs font-medium text-[var(--app-fg)]">{cli.label}</span>
                                <span className={`shrink-0 text-[11px] font-semibold ${cli.available ? 'text-green-600 dark:text-green-400' : 'text-[var(--app-hint)]'}`}>
                                    {cli.available ? '可用' : '未安装'}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : <div className="text-xs text-[var(--app-hint)]">runner 重启后会开始上报 Agent CLI 探测结果。</div>}
            </div>

            <div className="mt-3 truncate px-1 text-[11px] text-[var(--app-hint)]" title={runnerStartedAt ?? undefined}>
                启动时间: {runnerStartedAt ?? '—'}
            </div>
        </div>
    )
}

function RunnerSwitcherPanel(props: {
    machines: Machine[]
    selectedMachineId: string | null
    onSelect: (machineId: string) => void
}) {
    return (
        <div role="menu" aria-label="切换 runner" className="absolute left-1/2 top-full z-50 mt-3 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] py-1 shadow-[0_18px_50px_rgba(15,23,42,0.18)]">
            {props.machines.map((machine) => {
                const selected = machine.id === props.selectedMachineId
                return (
                    <button
                        key={machine.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        onClick={() => props.onSelect(machine.id)}
                        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                    >
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${machine.active ? 'bg-[#22c55e]' : 'bg-[#a3a3a3]'}`} aria-hidden="true" />
                        <LaptopIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-[var(--app-fg)]">{getMachineTitle(machine)}</span>
                            <span className="block truncate text-[11px] text-[var(--app-hint)]">{machine.metadata?.platform ?? 'unknown'} · HAPI {machine.metadata?.happyCliVersion ?? '—'}</span>
                        </span>
                        {selected ? <span className="text-xs font-semibold text-[var(--app-link)]">当前</span> : null}
                    </button>
                )
            })}
        </div>
    )
}

function SessionsPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const pathname = useLocation({ select: location => location.pathname })
    const matchRoute = useMatchRoute()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const { spawnSession, isPending: isQuickSessionPending } = useSpawnSession(api)
    const { addRecentPath, setLastUsedMachineId } = useRecentPaths()
    const { machines } = useMachines(api, true)
    const [isSyncingCodexSession, setIsSyncingCodexSession] = useState(false)
    const [codexSessions, setCodexSessions] = useState<CodexLocalSessionSummary[]>([])
    const [isLoadingCodexSessions, setIsLoadingCodexSessions] = useState(false)
    const [isSyncConfirmOpen, setIsSyncConfirmOpen] = useState(false)
    const [isRestartingCodexDesktop, setIsRestartingCodexDesktop] = useState(false)
    const [pendingDuplicateSessionIds, setPendingDuplicateSessionIds] = useState<string[]>([])
    const [duplicateSessionGroups, setDuplicateSessionGroups] = useState<CodexDuplicateSessionGroup[]>([])
    const [isDuplicateMergeConfirmOpen, setIsDuplicateMergeConfirmOpen] = useState(false)
    const [isMergingDuplicateSessions, setIsMergingDuplicateSessions] = useState(false)
    const [selectedRunnerMachineId, setSelectedRunnerMachineId] = useState<string | null>(loadSelectedRunnerMachineId)
    const [isRunnerDetailsOpen, setIsRunnerDetailsOpen] = useState(false)
    const [isRunnerSwitcherOpen, setIsRunnerSwitcherOpen] = useState(false)
    const runnerControlRef = useRef<HTMLDivElement>(null)

    const sessionMatch = matchRoute({ to: '/sessions/$sessionId', fuzzy: true })
    const isRecentCodexContext = pathname.startsWith('/sessions/codex/')
    const selectedSessionId = !isRecentCodexContext && sessionMatch && sessionMatch.sessionId !== 'new'
        ? sessionMatch.sessionId
        : null
    const selectedSession = useMemo(
        () => selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) ?? null : null,
        [selectedSessionId, sessions]
    )
    useEffect(() => {
        if (!selectedSessionId || !selectedSession) {
            return
        }
        markSessionSeen(selectedSessionId, selectedSession.updatedAt)
    }, [selectedSessionId, selectedSession?.updatedAt])
    const currentCodexSessionId = selectedSession?.metadata?.flavor === 'codex'
        ? (selectedSession.metadata.agentSessionId ?? null)
        : null
    const isSessionsIndex = pathname === '/sessions' || pathname === '/sessions/'
    const sidebar = useSidebarResize()
    const selectableMachines = useMemo(
        () => {
            const activeMachines = machines.filter((machine) => machine.active)
            return activeMachines.length > 0 ? activeMachines : machines
        },
        [machines]
    )
    const fallbackMachine = selectableMachines[0] ?? null
    const selectedRunnerMachine = useMemo(
        () => selectableMachines.find((machine) => machine.id === selectedRunnerMachineId) ?? fallbackMachine,
        [fallbackMachine, selectableMachines, selectedRunnerMachineId]
    )
    const selectedRunnerLabel = selectedRunnerMachine ? getMachineTitle(selectedRunnerMachine) : t('machine.unknown')
    const sessionsForSelectedRunner = useMemo(
        () => getSessionsForMachine(sessions, selectedRunnerMachine?.id),
        [sessions, selectedRunnerMachine?.id]
    )
    const selectRunnerMachine = useCallback((machineId: string) => {
        setSelectedRunnerMachineId(machineId)
        saveSelectedRunnerMachineId(machineId)
        setIsRunnerSwitcherOpen(false)
        setIsRunnerDetailsOpen(false)
    }, [])

    useEffect(() => {
        const sessionMachineId = selectedSession?.metadata?.machineId
        if (!sessionMachineId || sessionMachineId === selectedRunnerMachineId) return
        if (!selectableMachines.some((machine) => machine.id === sessionMachineId)) return
        selectRunnerMachine(sessionMachineId)
    }, [selectRunnerMachine, selectableMachines, selectedRunnerMachineId, selectedSession?.metadata?.machineId])

    useEffect(() => {
        if (selectableMachines.length === 0) return
        if (selectedRunnerMachine && selectableMachines.some((machine) => machine.id === selectedRunnerMachine.id)) return
        selectRunnerMachine(selectableMachines[0].id)
    }, [selectRunnerMachine, selectableMachines, selectedRunnerMachine])

    useEffect(() => {
        if (!isRunnerDetailsOpen && !isRunnerSwitcherOpen) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (target instanceof Node && runnerControlRef.current?.contains(target)) return
            setIsRunnerDetailsOpen(false)
            setIsRunnerSwitcherOpen(false)
        }
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            setIsRunnerDetailsOpen(false)
            setIsRunnerSwitcherOpen(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
        }
    }, [isRunnerDetailsOpen, isRunnerSwitcherOpen])

    const goNewSession = useCallback(() => {
        navigate({
            to: '/sessions/new',
            search: selectedRunnerMachine ? { machineId: selectedRunnerMachine.id } : {}
        })
    }, [navigate, selectedRunnerMachine])

    const createSessionInDirectory = useCallback(async (directory: string): Promise<boolean> => {
        if (!selectedRunnerMachine || isQuickSessionPending) return false

        try {
            const result = await spawnSession({
                machineId: selectedRunnerMachine.id,
                directory,
                ...loadDefaultNewSessionAgentConfig()
            })
            if (result.type !== 'success') {
                throw new Error(result.message)
            }

            setLastUsedMachineId(selectedRunnerMachine.id)
            addRecentPath(selectedRunnerMachine.id, directory)
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: result.sessionId }
            })
            return true
        } catch (error) {
            addToast({
                title: t('newSession.quickCreate.failed.title'),
                body: error instanceof Error && error.message
                    ? error.message
                    : t('newSession.quickCreate.failed.body'),
                sessionId: '',
                url: ''
            })
            return false
        }
    }, [addRecentPath, addToast, isQuickSessionPending, navigate, selectedRunnerMachine, setLastUsedMachineId, spawnSession, t])

    const handleSessionsMenuAction = useCallback((action: string) => {
        switch (action) {
            case 'new':
                goNewSession()
                return
            case 'browse':
                navigate({ to: '/browse' })
                return
            case 'memory':
                navigate({ to: '/memory' })
                return
            case 'shares':
                navigate({ to: '/shares' })
                return
            case 'settings':
                navigate({ to: '/settings' })
                return
            default:
                return
        }
    }, [goNewSession, navigate])

    const handleSelectSession = useCallback((sessionId: string) => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
        })
    }, [navigate])

    const handleOpenCodexSession = useCallback((session: CodexLocalSessionSummary) => {
        if (!selectedRunnerMachine) return
        navigate({
            to: '/sessions/codex/$codexSessionId',
            params: { codexSessionId: session.id },
            search: { machineId: selectedRunnerMachine.id }
        })
    }, [navigate, selectedRunnerMachine])

    const isCodexScriptTimeout = useCallback((message: string | null | undefined): boolean => {
        const raw = (message ?? '').trim()
        return /执行超时|timed\s*out|timeout/i.test(raw)
    }, [])

    const normalizeCodexScriptError = useCallback((message: string | null | undefined, fallback: string): string => {
        const raw = (message ?? '').trim()
        if (!raw) return fallback
        if (isCodexScriptTimeout(raw)) {
            return t('codexSync.error.timeout')
        }
        if (/当前会话仍处于活跃状态，请等待会话结束后重试|Active Hapi process already has this Codex thread/i.test(raw)) {
            return t('codexSync.error.active')
        }
        if (/未安装\/找不到codex客户端|unable to find codex launcher|找不到.*codex/i.test(raw)) {
            return t('codexSync.restart.failed.notFound')
        }
        return raw
    }, [isCodexScriptTimeout, t])

    const formatCodexSyncFailureBody = useCallback((reason: string): string => {
        if (
            reason === t('codexSync.error.timeout') ||
            reason === t('codexSync.error.active') ||
            reason === t('codexSync.restart.failed.notFound')
        ) {
            return reason
        }
        return t('codexSync.failed.bodyWithReason', { reason })
    }, [t])

    const closeDuplicateMergeDialog = useCallback(() => {
        // 中文注释：重复会话确认框关闭时一并清空“本次选中导入”的上下文，确保后续检测不会误用上一轮的 codexSessionId。
        setIsDuplicateMergeConfirmOpen(false)
        setPendingDuplicateSessionIds([])
        setDuplicateSessionGroups([])
    }, [])

    const handleRestartCodexDesktop = useCallback(async () => {
        setIsRestartingCodexDesktop(true)
        try {
            const status = await api.getCodexDesktopStatus()
            if (!status.codexClientAvailable) {
                throw new Error(t('codexSync.restart.failed.notFound'))
            }

            const result = await api.restartCodexDesktop()
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.restart.failed.body')))
            }
            addToast({
                title: t('codexSync.restart.started.title'),
                body: t('codexSync.restart.started.body'),
                sessionId: '',
                url: ''
            })
        } catch (error) {
            addToast({
                title: t('codexSync.restart.failed.title'),
                body: normalizeCodexScriptError(
                    error instanceof Error ? error.message : null,
                    t('codexSync.restart.failed.body')
                ),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsRestartingCodexDesktop(false)
        }
    }, [addToast, api, normalizeCodexScriptError, t])

    const handleMergeDuplicateSessions = useCallback(async () => {
        if (isMergingDuplicateSessions || pendingDuplicateSessionIds.length === 0) return

        setIsMergingDuplicateSessions(true)
        try {
            const result = await api.mergeCodexDuplicateSessions({ sessionIds: pendingDuplicateSessionIds })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.duplicates.merge.failed.body')))
            }

            addToast({
                title: t('codexSync.duplicates.merge.success.title'),
                body: t('codexSync.duplicates.merge.success.body'),
                sessionId: '',
                url: ''
            })

            const redirectTarget = selectedSessionId
                ? result.merged.find((group) => group.removedSessionIds?.includes(selectedSessionId))
                : undefined

            closeDuplicateMergeDialog()
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
                selectedSessionId
                    ? queryClient.invalidateQueries({ queryKey: queryKeys.session(selectedSessionId) })
                    : Promise.resolve(),
                selectedSessionId
                    ? queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedSessionId) })
                    : Promise.resolve()
            ])
            await refetch()

            if (redirectTarget?.canonicalSessionId) {
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: redirectTarget.canonicalSessionId }
                })
            }
        } catch (error) {
            addToast({
                title: t('codexSync.duplicates.merge.failed.title'),
                body: normalizeCodexScriptError(
                    error instanceof Error ? error.message : null,
                    t('codexSync.duplicates.merge.failed.body')
                ),
                sessionId: '',
                url: ''
            })
            throw error
        } finally {
            setIsMergingDuplicateSessions(false)
        }
    }, [
        addToast,
        api,
        closeDuplicateMergeDialog,
        isMergingDuplicateSessions,
        navigate,
        normalizeCodexScriptError,
        pendingDuplicateSessionIds,
        queryClient,
        refetch,
        selectedSessionId,
        t
    ])

    const openCodexImportDialog = useCallback(async () => {
        if (isLoadingCodexSessions) return

        setIsSyncConfirmOpen(true)
        setIsLoadingCodexSessions(true)
        try {
            const result = await api.getCodexSessions()
            setCodexSessions(result.sessions)
        } catch (error) {
            setCodexSessions([])
            const reason = normalizeCodexScriptError(
                error instanceof Error ? error.message : null,
                t('dialog.error.default')
            )
            addToast({
                title: t('codexSync.failed.title'),
                body: formatCodexSyncFailureBody(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsLoadingCodexSessions(false)
        }
    }, [addToast, api, formatCodexSyncFailureBody, isLoadingCodexSessions, normalizeCodexScriptError, t])

    const handleImportCodexSessions = useCallback(async (sessionIds: string[]) => {
        if (isSyncingCodexSession || isLoadingCodexSessions) return

        setIsSyncingCodexSession(true)
        try {
            // 中文注释：弹窗提交的是本地 Codex thread ID；后端会直接读取这些 transcript 并导入到 Hapi。
            const result = await api.syncCodexSession({ sessionIds })
            if (!result.success) {
                throw new Error(normalizeCodexScriptError(result.error, t('codexSync.failed.body')))
            }

            addToast({
                title: t('codexSync.success.title'),
                body: t('codexSync.success.body', { n: result.syncedCount ?? sessionIds.length }),
                sessionId: '',
                url: ''
            })
            // 中文注释：导入成功后先在浏览器侧记住这些 Codex thread 的导入时间，供左侧会话列表显示特殊时间文案。
            markCodexSessionsImported(sessionIds)
            setIsSyncConfirmOpen(false)
            await refetch()

            setPendingDuplicateSessionIds([])
            setDuplicateSessionGroups([])
            setIsDuplicateMergeConfirmOpen(false)
            try {
                // 中文注释：重复会话检测严格限定在这次用户勾选导入的 codexSessionId 范围内；未勾选的其它会话不参与检测，也不弹合并提示。
                const duplicateResult = await api.getCodexDuplicateSessions({ sessionIds })
                if (!duplicateResult.success) {
                    throw new Error(normalizeCodexScriptError(
                        duplicateResult.error,
                        t('codexSync.duplicates.detect.failed.body')
                    ))
                }

                if (duplicateResult.duplicates.length > 0) {
                    setPendingDuplicateSessionIds(sessionIds)
                    setDuplicateSessionGroups(duplicateResult.duplicates)
                    setIsDuplicateMergeConfirmOpen(true)
                }
            } catch (duplicateError) {
                addToast({
                    title: t('codexSync.duplicates.detect.failed.title'),
                    body: normalizeCodexScriptError(
                        duplicateError instanceof Error ? duplicateError.message : null,
                        t('codexSync.duplicates.detect.failed.body')
                    ),
                    sessionId: '',
                    url: ''
                })
            }
        } catch (syncError) {
            const reason = normalizeCodexScriptError(
                syncError instanceof Error ? syncError.message : null,
                t('dialog.error.default')
            )
            addToast({
                title: t('codexSync.failed.title'),
                body: formatCodexSyncFailureBody(reason),
                sessionId: '',
                url: ''
            })
        } finally {
            setIsSyncingCodexSession(false)
        }
    }, [
        addToast,
        api,
        formatCodexSyncFailureBody,
        isLoadingCodexSessions,
        isSyncingCodexSession,
        normalizeCodexScriptError,
        refetch,
        setDuplicateSessionGroups,
        setIsDuplicateMergeConfirmOpen,
        setPendingDuplicateSessionIds,
        t
    ])

    return (
        <>
            <div className="flex h-full min-h-0">
            <div
                className={`session-list-screen ${isSessionsIndex ? 'flex' : 'hidden lg:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)] [font-family:var(--app-control-font-family)]`}
                style={{ '--sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
            >
                <div className="bg-[var(--app-bg)] pt-[var(--app-safe-area-top)]">
                    <div className="mx-auto grid w-full max-w-[680px] grid-cols-[52px_1fr_52px] items-center px-4 pb-2 pt-3 sm:px-6">
                        <div className="relative flex h-[52px] w-[52px] items-center justify-center rounded-xl text-[var(--app-fg)] transition-opacity hover:opacity-70 focus-within:ring-2 focus-within:ring-[var(--app-link)]">
                            <SettingsIcon className="pointer-events-none h-6 w-6" />
                            <select
                                aria-label={t('session.more')}
                                data-testid="sessions-menu-button"
                                defaultValue=""
                                onClick={() => {
                                    setIsRunnerDetailsOpen(false)
                                    setIsRunnerSwitcherOpen(false)
                                }}
                                onChange={(event) => {
                                    const action = event.currentTarget.value
                                    event.currentTarget.value = ''
                                    handleSessionsMenuAction(action)
                                }}
                                className="absolute inset-0 z-10 h-full w-full cursor-pointer touch-manipulation opacity-0"
                                title={t('session.more')}
                            >
                                <option value="" disabled>{t('session.more')}</option>
                                <option value="new">{t('sessions.new')}</option>
                                <option value="browse">{t('browse.nav')}</option>
                                <option value="memory">{t('openViking.nav')}</option>
                                <option value="shares">{t('shares.nav')}</option>
                                <option value="settings">{t('settings.title')}</option>
                            </select>
                        </div>
                        <div ref={runnerControlRef} className="relative flex min-w-0 items-center justify-center gap-1.5 text-sm font-medium leading-5 text-[var(--app-hint)]">
                                <button
                                    type="button"
                                    onClick={() => {
                                        setIsRunnerDetailsOpen((open) => !open)
                                        setIsRunnerSwitcherOpen(false)
                                    }}
                                    className="group/runner flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    title="Runner 状态"
                                    aria-haspopup="dialog"
                                    aria-expanded={isRunnerDetailsOpen}
                                >
                                    <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${selectedRunnerMachine?.active ? 'bg-[#22c55e]' : 'bg-[#a3a3a3]'}`} aria-hidden="true" />
                                    <LaptopIcon className="h-[18px] w-[18px] shrink-0" />
                                    <span className="truncate">{selectedRunnerLabel}</span>
                                </button>
                                {selectableMachines.length > 1 ? (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIsRunnerSwitcherOpen((open) => !open)
                                            setIsRunnerDetailsOpen(false)
                                        }}
                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                        title="切换 runner"
                                        aria-label="切换 runner"
                                        aria-haspopup="menu"
                                        aria-expanded={isRunnerSwitcherOpen}
                                    >
                                        <SwitchWorkspaceIcon className="h-3.5 w-3.5" />
                                    </button>
                                ) : null}
                                {isRunnerDetailsOpen && selectedRunnerMachine ? (
                                    <RunnerDetailsPanel machine={selectedRunnerMachine} />
                                ) : null}
                                {isRunnerSwitcherOpen && selectableMachines.length > 1 ? (
                                    <RunnerSwitcherPanel
                                        machines={selectableMachines}
                                        selectedMachineId={selectedRunnerMachine?.id ?? null}
                                        onSelect={selectRunnerMachine}
                                    />
                                ) : null}
                            </div>
                        <div aria-hidden="true" />
                    </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col">
                    {error ? (
                        <div className="mx-auto w-full max-w-content px-3 py-2">
                            <div className="text-sm text-red-600">{error}</div>
                        </div>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col">
                        <RecentCodexSessions
                            api={api}
                            machineId={selectedRunnerMachine?.id ?? null}
                            hapiSessions={sessionsForSelectedRunner}
                            hapiIsLoading={isLoading}
                            selectedSessionId={selectedSessionId}
                            onOpenHapi={(session) => handleSelectSession(session.id)}
                            onOpen={handleOpenCodexSession}
                            embedded
                            hideHeader
                            recentOnly
                            limit={100}
                            onNewSessionInDirectory={selectedRunnerMachine ? createSessionInDirectory : undefined}
                            isNewSessionPending={isQuickSessionPending}
                            realtimeAvailable={selectedRunnerMachine?.active === true
                                && selectedRunnerMachine.metadata?.nativeCodexRealtime === true}
                        />
                    </div>
                </div>
            </div>

            {/* Resize handle - desktop only */}
            <div
                className="sidebar-resize-handle hidden lg:block shrink-0"
                data-dragging={sidebar.isDragging || undefined}
                onPointerDown={sidebar.onPointerDown}
            />

            <div className={`${isSessionsIndex ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                <div className="flex-1 min-h-0">
                    <Outlet />
                </div>
            </div>
            </div>
            {/* 中文注释：这里展示的是本地 Codex transcript 列表；默认尝试勾选当前 Hapi 会话关联的 Codex thread。 */}
            <CodexSessionSyncDialog
                isOpen={isSyncConfirmOpen}
                onClose={() => setIsSyncConfirmOpen(false)}
                sessions={codexSessions}
                currentCodexSessionId={currentCodexSessionId}
                onConfirm={handleImportCodexSessions}
                onRestartCodexDesktop={handleRestartCodexDesktop}
                isPending={isSyncingCodexSession}
                isRestartingCodexDesktop={isRestartingCodexDesktop}
                isLoading={isLoadingCodexSessions}
            />
            <ConfirmDialog
                isOpen={isDuplicateMergeConfirmOpen && duplicateSessionGroups.length > 0}
                onClose={closeDuplicateMergeDialog}
                title={t('codexSync.duplicates.confirm.title')}
                description={t('codexSync.duplicates.confirm.description')}
                confirmLabel={t('codexSync.duplicates.confirm.confirm')}
                confirmingLabel={t('codexSync.duplicates.confirm.confirming')}
                onConfirm={handleMergeDuplicateSessions}
                isPending={isMergingDuplicateSessions}
            />
        </>
    )
}

function SessionsIndexPage() {
    return null
}

/**
 * Classify a thrown send error into a {message, code} pair the composer can
 * render.  `code` lets the consumer attach a recovery affordance (Reopen on
 * `session_inactive`) without re-inspecting the raw error.
 *
 * `request<T>` in the api client throws `ApiError` for !res.ok with `status`
 * and `code` parsed from the JSON body.  Older / non-JSON failures arrive as
 * plain `Error`; we surface those by their message verbatim, falling back to
 * a localized default when nothing usable is present (e.g. an aborted fetch
 * that resolved with no message).
 */
function classifySendError(
    error: unknown,
    t: (key: string) => string,
): { message: string; code: string | null } {
    if (error instanceof ApiError && error.status === 409 && error.code === 'session_inactive') {
        return { message: t('chat.sendError.sessionInactive'), code: 'session_inactive' }
    }
    if (error instanceof Error && error.message) {
        return { message: error.message, code: null }
    }
    return { message: t('chat.sendError.fallback'), code: null }
}

function SessionPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const { outline, fromSessionId } = useSearch({ from: '/sessions/$sessionId' })
    const {
        session,
        error: sessionError,
        refetch: refetchSession,
    } = useSession(api, sessionId)
    const {
        messages,
        pendingMessages,
        warning: messagesWarning,
        isLoading: messagesLoading,
        isLoadingMore: messagesLoadingMore,
        hasMore: messagesHasMore,
        loadMore: loadMoreMessages,
        refetch: refetchMessages,
        pendingCount,
        messagesVersion,
        flushPending,
        setAtBottom,
    } = useMessages(api, sessionId)

    // Tracks the most recent send the hub rejected (4xx/5xx/network), keyed
    // by the session the failed POST actually targeted (post-resolveSessionId).
    // assistant-ui clears the composer eagerly when a send is invoked, so to
    // retain the typed text on error we keep it here and hand it back to the
    // composer for restore + visual error affordance.  Keying by sessionId
    // covers the inactive-session resume race: useSendMessage can resolve
    // the target id, kick off async navigation to it, and then have the POST
    // fail before navigation completes.  Without keying, we'd restore the
    // text into the OLD session's composer and the next render would clear
    // it.  The bumped `id` still lets the composer dedupe restorations of
    // identical text.
    //
    // We persist the classifier `code` (not the bound action) so the
    // composer-visible action stays reactive to `reopeningSessionId` state
    // changes -- the action is built fresh on each render from {raw error
    // record} x {current reopen state}.  See classifySendError + the
    // Reopen affordance below.
    type RawSendError = {
        id: number
        text: string
        message: string
        code: string | null
        scheduledAt: number | null
    }
    const [sendErrors, setSendErrors] = useState<Record<string, RawSendError>>({})
    const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null)
    const sendErrorIdRef = useRef(0)
    const clearSendError = useCallback(() => {
        setSendErrors((prev) => {
            if (!(sessionId in prev)) return prev
            const next = { ...prev }
            delete next[sessionId]
            return next
        })
    }, [sessionId])

    // Reopen recovery (#918): one-click affordance attached to the inline
    // composer error when the rejected send was inactive-session.  Mirrors
    // SessionList's Reopen UX -- POST /sessions/:id/reopen via
    // api.reopenSession -- so the operator's mental model is consistent
    // across surfaces.  We do NOT auto-replay the send: per #917 the reopen
    // path has known fragility, so the operator re-clicks Send on the
    // restored composer text once Reopen lands.
    const reopenFromErrorAffordance = useCallback((errorSessionId: string) => {
        if (!api) return
        setReopeningSessionId((prev) => prev ?? errorSessionId)
        void (async () => {
            try {
                const result = await api.reopenSession(errorSessionId)
                // Clear the inline error -- the operator now has a live
                // session to retry against.
                setSendErrors((prev) => {
                    if (!(errorSessionId in prev)) return prev
                    const next = { ...prev }
                    delete next[errorSessionId]
                    return next
                })
                await queryClient.invalidateQueries({ queryKey: queryKeys.session(result.sessionId) })
                await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                if (result.sessionId && result.sessionId !== errorSessionId) {
                    navigate({
                        to: '/sessions/$sessionId',
                        params: { sessionId: result.sessionId },
                        replace: true
                    })
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: errorSessionId,
                    url: ''
                })
            } finally {
                setReopeningSessionId(null)
            }
        })()
    }, [api, queryClient, navigate, addToast, t])

    const rawSendError = sendErrors[sessionId] ?? null
    const sendError: ComposerSendError | null = rawSendError
        ? {
            id: rawSendError.id,
            text: rawSendError.text,
            message: rawSendError.message,
            scheduledAt: rawSendError.scheduledAt,
            action: rawSendError.code === 'session_inactive'
                ? {
                    label: t('chat.sendError.sessionInactive.action'),
                    onClick: () => reopenFromErrorAffordance(sessionId),
                    pending: reopeningSessionId === sessionId
                }
                : null
        }
        : null

    const {
        sendMessage,
        retryMessage,
        isSending,
    } = useSendMessage(api, sessionId, {
        isSessionThinking: session?.thinking ?? false,
        onSuccess: (sentSessionId) => {
            clearDraftsAfterSend(sentSessionId, sessionId)
            // 中文注释：一旦用户已经在 Hapi 内继续这个 Codex 会话，就清除"刚从 Codex 导入"的标记。
            clearCodexImportedSession(session?.metadata?.codexSessionId)
            // A successful send supersedes any previously-rendered error
            // for that session.  Other sessions' errors stay put.
            setSendErrors((prev) => {
                if (!(sentSessionId in prev)) return prev
                const next = { ...prev }
                delete next[sentSessionId]
                return next
            })
        },
        onError: (info: SendErrorInfo) => {
            sendErrorIdRef.current += 1
            const { message, code } = classifySendError(info.error, t)
            setSendErrors((prev) => ({
                ...prev,
                [info.sessionId]: {
                    id: sendErrorIdRef.current,
                    text: info.text,
                    message,
                    code,
                    scheduledAt: info.scheduledAt
                }
            }))
        },
        resolveSessionId: async (currentSessionId) => {
            if (!api || !session || session.active) {
                return currentSessionId
            }
            if (!inactiveSessionCanResume(session, messages.length)) {
                // #918: surface as a session_inactive ApiError so the
                // onError consumer's classifier renders the Reopen
                // affordance.  `status: 409` mirrors the hub guard for
                // structural parity; no HTTP call was made.
                throw new ApiError(
                    t('chat.sendError.sessionInactive'),
                    409,
                    'session_inactive',
                )
            }
            try {
                return await api.resumeSession(currentSessionId, { permissionMode: session.permissionMode ?? undefined })
            } catch (error) {
                const message = error instanceof Error ? error.message : t('dialog.error.default')
                addToast({
                    title: t('resume.failed.title'),
                    body: message,
                    sessionId: currentSessionId,
                    url: ''
                })
                // Rebrand as a session_inactive ApiError so the inline
                // affordance offers Reopen (a separate code path from the
                // failed Resume) and the operator has a recovery click.
                throw new ApiError(
                    t('chat.sendError.sessionInactive'),
                    409,
                    'session_inactive',
                )
            }
        },
        onSessionResolved: (resolvedSessionId) => {
            void (async () => {
                if (api) {
                    if (session && resolvedSessionId !== session.id) {
                        seedMessageWindowFromSession(session.id, resolvedSessionId)
                        queryClient.setQueryData(queryKeys.session(resolvedSessionId), {
                            session: { ...session, id: resolvedSessionId, active: true }
                        })
                    }
                    try {
                        await Promise.all([
                            queryClient.prefetchQuery({
                                queryKey: queryKeys.session(resolvedSessionId),
                                queryFn: () => api.getSession(resolvedSessionId),
                            }),
                            fetchLatestMessages(api, resolvedSessionId),
                        ])
                    } catch {
                    }
                }
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: resolvedSessionId },
                    replace: true
                })
            })()
        },
        onBlocked: (reason) => {
            if (reason === 'no-api') {
                addToast({
                    title: t('send.blocked.title'),
                    body: t('send.blocked.noConnection'),
                    sessionId: sessionId ?? '',
                    url: ''
                })
            }
            // 'no-session' and 'pending' don't need toast - either invalid state or expected behavior
        }
    })

    // Get agent type from session metadata for slash commands
    const agentType = session?.metadata?.flavor ?? 'claude'
    const {
        commands: slashCommands,
        getSuggestions: getSlashSuggestions,
    } = useSlashCommands(api, sessionId, agentType)
    const {
        skills,
        isLoading: skillsLoading,
        error: skillsError,
        getSuggestions: getSkillSuggestions,
    } = useSkills(api, sessionId)

    const getAutocompleteSuggestions = useCallback(async (query: string) => {
        if (query.startsWith('$')) {
            return await getSkillSuggestions(query)
        }
        return await getSlashSuggestions(query)
    }, [getSkillSuggestions, getSlashSuggestions])

    const refreshSelectedSession = useCallback(() => {
        void refetchSession()
        void refetchMessages()
    }, [refetchMessages, refetchSession])

    const handleInitialOutlineConsumed = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            search: fromSessionId ? { fromSessionId } : {},
            replace: true,
        })
    }, [fromSessionId, navigate, sessionId])

    const goBack = useCallback(() => {
        if (fromSessionId && fromSessionId !== sessionId) {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: fromSessionId },
                search: {},
            })
            return
        }

        // The detail page has one unambiguous parent. Avoid deriving a parent
        // from the restored PWA URL; that can leave the route unchanged.
        navigate({ to: '/sessions' })
    }, [fromSessionId, navigate, sessionId])

    if (!session) {
        if (sessionError) {
            return (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
                    <div className="text-sm font-medium text-[var(--app-fg)]">Session unavailable</div>
                    <div className="max-w-md text-xs text-[var(--app-hint)]">{sessionError}</div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => navigate({ to: '/sessions', replace: true })}
                            className="rounded-md border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]"
                        >
                            Back to sessions
                        </button>
                        <button
                            type="button"
                            onClick={() => { void refetchSession() }}
                            className="rounded-md bg-[var(--app-button)] px-3 py-1.5 text-sm text-[var(--app-button-text)]"
                        >
                            Retry
                        </button>
                    </div>
                </div>
            )
        }
        return <SessionEntryLoading onBack={goBack} />
    }

    return (
        <Suspense fallback={<SessionEntryLoading onBack={goBack} />}>
            <SessionChat
                api={api}
                session={session}
                messages={messages}
                pendingMessages={pendingMessages}
                messagesWarning={messagesWarning}
                hasMoreMessages={messagesHasMore}
                isLoadingMessages={messagesLoading}
                isLoadingMoreMessages={messagesLoadingMore}
                isSending={isSending}
                pendingCount={pendingCount}
                messagesVersion={messagesVersion}
                onBack={goBack}
                onRefresh={refreshSelectedSession}
                onLoadMore={loadMoreMessages}
                onSend={sendMessage}
                onFlushPending={flushPending}
                onAtBottomChange={setAtBottom}
                onRetryMessage={retryMessage}
                autocompleteSuggestions={getAutocompleteSuggestions}
                availableSlashCommands={slashCommands}
                skills={skills}
                skillsLoading={skillsLoading}
                skillsError={skillsError}
                sendError={sendError}
                onClearSendError={clearSendError}
                initialOutlineOpen={outline}
                onInitialOutlineConsumed={handleInitialOutlineConsumed}
            />
        </Suspense>
    )
}

function CodexSessionContextRoute() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { codexSessionId } = useParams({ from: '/sessions/codex/$codexSessionId' })
    const { machineId } = useSearch({ from: '/sessions/codex/$codexSessionId' })
    const { machines } = useMachines(api, Boolean(machineId))
    const selectedMachine = machines.find((machine) => machine.id === machineId)
    const realtimeAvailable = selectedMachine?.active === true
        && selectedMachine.metadata?.nativeCodexRealtime === true

    return (
        <CodexSessionContextPage
            api={api}
            sessionId={codexSessionId}
            machineId={machineId}
            machineAvailable={selectedMachine?.active}
            realtimeAvailable={realtimeAvailable}
            onBack={() => navigate({ to: '/sessions' })}
            onForked={(sessionId) => navigate({
                to: '/sessions/$sessionId',
                params: { sessionId }
            })}
        />
    )
}

function SessionDetailRoute() {
    const { api } = useAppContext()
    const pathname = useLocation({ select: location => location.pathname })
    const { sessionId } = useParams({ from: '/sessions/$sessionId' })
    const navigate = useNavigate()
    const { notFound: sessionNotFound } = useSession(api, sessionId)
    const basePath = `/sessions/${sessionId}`
    const isChat = pathname === basePath || pathname === `${basePath}/`

    useEffect(() => {
        if (!sessionNotFound) {
            return
        }
        navigate({ to: '/sessions', replace: true })
    }, [navigate, sessionNotFound])

    if (sessionNotFound) {
        return (
            <div className="flex-1 flex items-center justify-center p-4">
                <LoadingState label="Session not found. Returning to sessions…" className="text-sm" />
            </div>
        )
    }

    return isChat ? <SessionPage /> : <Outlet />
}

function NewSessionPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const { directory: initialDirectory, machineId: initialMachineId, shareTransferId } = newSessionRoute.useSearch()

    const handleCancel = useCallback(() => {
        if (shareTransferId) {
            void deleteShareTransfer(shareTransferId)
        }
        navigate({ to: '/sessions' })
    }, [navigate, shareTransferId])

    const handleSuccess = useCallback((sessionId: string) => {
        if (shareTransferId) {
            setSharePendingTransfer(shareTransferId)
        }
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        // Replace current page with /sessions to clear spawn flow from history
        navigate({ to: '/sessions', replace: true })
        // Then navigate to new session
        requestAnimationFrame(() => {
            navigate({
                to: '/sessions/$sessionId',
                params: { sessionId },
            })
        })
    }, [navigate, queryClient, shareTransferId])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        // Forward the currently-selected machine so /browse opens scoped to
        // it rather than falling back to `hapi:lastMachineId`, which can
        // disagree if the user changed machines without yet creating a
        // session. Preserve shareTransferId so a share-target spawn that
        // detours through /browse still seeds the composer after success.
        const search: { machineId?: string; shareTransferId?: string } = {}
        if (args.machineId) search.machineId = args.machineId
        if (shareTransferId) search.shareTransferId = shareTransferId
        navigate({ to: '/browse', search })
    }, [navigate, shareTransferId])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="bg-[var(--app-bg)] pt-[var(--app-safe-area-top)]">
                <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 py-3 sm:px-6">
                    {!isTelegramApp() && (
                        <button
                            type="button"
                            onClick={goBack}
                            className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] shadow-[0_1px_4px_rgba(0,0,0,0.03)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        >
                            <BackIcon />
                        </button>
                    )}
                    <div className="flex-1 text-lg font-semibold leading-6 text-[var(--app-fg)]">{t('newSession.title')}</div>
                </div>
            </div>

            <div
                className="app-scroll-y flex-1 min-h-0"
                style={{ paddingBottom: 'calc(var(--app-floating-bottom-offset, 0px) + var(--app-safe-area-bottom))' }}
            >
                {machinesError ? (
                    <div className="p-3 text-sm text-red-600">
                        {machinesError}
                    </div>
                ) : null}

                <NewSession
                    api={api}
                    machines={machines}
                    isLoading={machinesLoading}
                    onCancel={handleCancel}
                    onSuccess={handleSuccess}
                    onChooseFolder={handleChooseFolder}
                    initialDirectory={initialDirectory}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

function BrowsePage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()
    const { machineId: initialMachineId, shareTransferId } = browseRoute.useSearch()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        navigate({
            to: '/sessions/new',
            search: shareTransferId
                ? { directory, machineId, shareTransferId }
                : { directory, machineId }
        })
    }, [navigate, shareTransferId])

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-bg)] p-3 pt-[calc(0.75rem+var(--app-safe-area-top))]">
                {!isTelegramApp() && (
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                )}
                <div className="flex-1 font-semibold">{t('browse.title')}</div>
            </div>

            <div className="flex-1 min-h-0">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={initialMachineId}
                />
            </div>
        </div>
    )
}

const rootRoute = createRootRoute({
    component: App,
})

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <Navigate to="/sessions" replace />,
})

const sessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions',
    component: SessionsPage,
})

const sessionsIndexRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '/',
    component: SessionsIndexPage,
})

const codexSessionContextRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'codex/$codexSessionId',
    validateSearch: (search: Record<string, unknown>): { machineId?: string } => {
        const machineId = typeof search.machineId === 'string' && search.machineId.trim().length > 0
            ? search.machineId
            : undefined
        return machineId ? { machineId } : {}
    },
    component: CodexSessionContextRoute,
})

type CodexSessionFileSearch = {
    machineId?: string
    path: string
    line?: number
    column?: number
}

const codexSessionFileRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'codex/$codexSessionId/file',
    validateSearch: (search: Record<string, unknown>): CodexSessionFileSearch => {
        const machineId = typeof search.machineId === 'string' && search.machineId.trim().length > 0
            ? search.machineId.trim()
            : undefined
        const path = typeof search.path === 'string' ? search.path : ''
        const parsePositiveInt = (value: unknown): number | undefined => {
            const text = typeof value === 'number'
                ? String(value)
                : typeof value === 'string'
                    ? value
                    : ''
            if (!/^\d+$/.test(text)) return undefined
            const parsed = Number(text)
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
        }
        const line = parsePositiveInt(search.line)
        const column = parsePositiveInt(search.column)

        return {
            ...(machineId ? { machineId } : {}),
            path,
            ...(line !== undefined ? { line } : {}),
            ...(column !== undefined ? { column } : {})
        }
    },
    component: CodexFilePage,
})

const sessionDetailRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: '$sessionId',
    validateSearch: (search: Record<string, unknown>): { outline?: boolean; fromSessionId?: string } => {
        const outline = search.outline === true || search.outline === 'true'
        const fromSessionId = typeof search.fromSessionId === 'string' && search.fromSessionId.trim().length > 0
            ? search.fromSessionId
            : undefined
        return {
            ...(outline ? { outline: true } : {}),
            ...(fromSessionId ? { fromSessionId } : {})
        }
    },
    component: SessionDetailRoute,
})

const sessionFilesRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'files',
    validateSearch: (search: Record<string, unknown>): { tab?: 'changes' | 'directories' } => {
        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined

        return tab ? { tab } : {}
    },
    component: FilesPage,
})

const sessionTerminalRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'terminal',
    component: TerminalPage,
})

type SessionFileSearch = {
    path: string
    staged?: boolean
    tab?: 'changes' | 'directories'
    from?: 'session' | 'files'
    line?: number
    column?: number
}

const sessionFileRoute = createRoute({
    getParentRoute: () => sessionDetailRoute,
    path: 'file',
    validateSearch: (search: Record<string, unknown>): SessionFileSearch => {
        const path = typeof search.path === 'string' ? search.path : ''
        const staged = search.staged === true || search.staged === 'true'
            ? true
            : search.staged === false || search.staged === 'false'
                ? false
                : undefined

        const tabValue = typeof search.tab === 'string' ? search.tab : undefined
        const tab = tabValue === 'directories'
            ? 'directories'
            : tabValue === 'changes'
                ? 'changes'
                : undefined
        const fromValue = typeof search.from === 'string' ? search.from : undefined
        const from = fromValue === 'session'
            ? 'session'
            : fromValue === 'files'
                ? 'files'
                : undefined
        const parsePositiveInt = (value: unknown): number | undefined => {
            const text = typeof value === 'number'
                ? String(value)
                : typeof value === 'string'
                    ? value
                    : ''
            if (!/^\d+$/.test(text)) return undefined
            const parsed = Number(text)
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
        }
        const line = parsePositiveInt(search.line)
        const column = parsePositiveInt(search.column)

        const result: SessionFileSearch = { path }
        if (staged !== undefined) {
            result.staged = staged
        }
        if (tab !== undefined) {
            result.tab = tab
        }
        if (from !== undefined) {
            result.from = from
        }
        if (line !== undefined) {
            result.line = line
        }
        if (column !== undefined) {
            result.column = column
        }
        return result
    },
    component: FilePage,
})

type NewSessionSearch = {
    directory?: string
    machineId?: string
    shareTransferId?: string
}

const newSessionRoute = createRoute({
    getParentRoute: () => sessionsRoute,
    path: 'new',
    validateSearch: (search: Record<string, unknown>): NewSessionSearch => {
        const result: NewSessionSearch = {}
        if (typeof search.directory === 'string' && search.directory) {
            result.directory = search.directory
        }
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: NewSessionPage,
})

const browseRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/browse',
    validateSearch: (search: Record<string, unknown>): { machineId?: string; shareTransferId?: string } => {
        const result: { machineId?: string; shareTransferId?: string } = {}
        if (typeof search.machineId === 'string' && search.machineId) {
            result.machineId = search.machineId
        }
        if (typeof search.shareTransferId === 'string' && search.shareTransferId) {
            result.shareTransferId = search.shareTransferId
        }
        return result
    },
    component: BrowsePage,
})

const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    validateSearch: (search: Record<string, unknown>): { machineId?: string } => {
        const machineId = typeof search.machineId === 'string' && search.machineId.trim().length > 0
            ? search.machineId
            : undefined
        return machineId ? { machineId } : {}
    },
    component: OpenVikingPage,
})

const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: SettingsPage,
})

const sharesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/shares',
    component: SharesPage,
})

// Web Share Target landing route. Service worker (`web/src/sw.ts`)
// intercepts the manifest's `POST /share` and 303-redirects here with an
// IDB transfer id. `error=ingest` is set when the SW failed to write IDB.
const shareRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/share',
    validateSearch: (search: Record<string, unknown>): { id?: string; error?: string } => {
        const result: { id?: string; error?: string } = {}
        if (typeof search.id === 'string' && search.id) {
            result.id = search.id
        }
        if (typeof search.error === 'string' && search.error) {
            result.error = search.error
        }
        return result
    },
    component: SharePage,
})

export const routeTree = rootRoute.addChildren([
    indexRoute,
    sessionsRoute.addChildren([
        sessionsIndexRoute,
        newSessionRoute,
        codexSessionContextRoute,
        codexSessionFileRoute,
        sessionDetailRoute.addChildren([
            sessionTerminalRoute,
            sessionFilesRoute,
            sessionFileRoute,
        ]),
    ]),
    browseRoute,
    memoryRoute,
    sharesRoute,
    settingsRoute,
    shareRoute,
])

type RouterHistory = Parameters<typeof createRouter>[0]['history']

export function createAppRouter(history?: RouterHistory) {
    return createRouter({
        routeTree,
        history,
        scrollRestoration: true,
        getScrollRestorationKey,
    })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
    interface Register {
        router: AppRouter
    }
}
