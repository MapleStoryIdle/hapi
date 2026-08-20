import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { SessionDetailHeader } from '@/components/SessionDetailHeader'
import type { Machine, OpenVikingStatusResponse } from '@/types/api'

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

function machineLabel(machine: Machine): string {
    return machine.metadata?.host?.trim() || machine.id.slice(0, 8)
}

export function buildOpenVikingStudioSrc(args: {
    baseUrl: string
    machineId: string
    token: string
}): string {
    const url = new URL(
        `/api/openviking/machines/${encodeURIComponent(args.machineId)}/studio/`,
        args.baseUrl || window.location.origin
    )
    url.searchParams.set('hapiOpenVikingToken', args.token)
    return url.toString()
}

export default function OpenVikingPage() {
    const { api, baseUrl, token } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { machineId } = useSearch({ from: '/memory' })
    const [status, setStatus] = useState<OpenVikingStatusResponse | null>(null)
    const [statusLoading, setStatusLoading] = useState(false)
    const [reloadKey, setReloadKey] = useState(0)

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

    useEffect(() => {
        void refreshStatus()
    }, [refreshStatus])

    const src = useMemo(() => {
        if (!selectedMachine || !status?.ok) return null
        return buildOpenVikingStudioSrc({
            baseUrl,
            machineId: selectedMachine.id,
            token
        })
    }, [baseUrl, selectedMachine, status?.ok, token])

    const selectMachine = useCallback((nextMachineId: string) => {
        navigate({
            to: '/memory',
            search: { machineId: nextMachineId }
        })
    }, [navigate])

    const reload = useCallback(() => {
        setReloadKey((value) => value + 1)
        void refreshStatus()
    }, [refreshStatus])

    const subtitle = selectedMachine
        ? `${machineLabel(selectedMachine)}${status?.version ? ` · v${status.version}` : ''}`
        : t('openViking.noMachines')

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <SessionDetailHeader
                title={t('openViking.title')}
                subtitle={subtitle}
                onBack={() => navigate({ to: '/sessions' })}
                actions={(
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
                    ) : src ? (
                        <iframe
                            key={`${src}:${reloadKey}`}
                            src={src}
                            title={t('openViking.title')}
                            className="min-h-0 flex-1 border-0 bg-white"
                            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                        />
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
