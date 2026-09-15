import { useCallback, useEffect, useState } from 'react'
import { PackageCheck, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ManagedSkillControlResponse, ManagedSkillMachineState } from '@hapi/protocol'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useTranslation } from '@/lib/use-translation'

function BackIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function stateLabel(state: ManagedSkillMachineState['state'], t: ReturnType<typeof useTranslation>['t']): string {
    if (state === 'ready') return t('skills.state.ready')
    if (state === 'outdated') return t('skills.state.outdated')
    if (state === 'missing') return t('skills.state.firstUse')
    if (state === 'offline') return t('skills.state.offline')
    if (state === 'unsupported') return t('skills.state.upgrade')
    return t('skills.state.error')
}

export default function SkillsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [data, setData] = useState<ManagedSkillControlResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [pending, setPending] = useState<string | null>(null)

    const load = useCallback(async () => {
        setError(null)
        try {
            setData(await api.getManagedSkills())
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t('skills.loadFailed'))
        } finally {
            setLoading(false)
        }
    }, [api, t])

    useEffect(() => {
        void load()
    }, [load])

    const setEnabled = useCallback(async (skillId: string, enabled: boolean) => {
        setPending(`toggle:${skillId}`)
        try {
            await api.setManagedSkillEnabled(skillId, enabled)
            await queryClient.invalidateQueries({
                predicate: (query) => query.queryKey[0] === 'skills' || query.queryKey[0] === 'codex-session-composer-capabilities'
            })
            await load()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t('skills.saveFailed'))
        } finally {
            setPending(null)
        }
    }, [api, load, queryClient, t])

    const cacheNow = useCallback(async (skillId: string, machineId: string) => {
        setPending(`cache:${skillId}:${machineId}`)
        try {
            await api.cacheManagedSkill(skillId, machineId)
            await load()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t('skills.cacheFailed'))
        } finally {
            setPending(null)
        }
    }, [api, load, t])

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]">
                <div className="mx-auto flex max-w-[680px] items-center gap-3">
                    <button type="button" onClick={goBack} aria-label={t('skills.back')} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-base font-semibold text-[var(--app-fg)]">{t('skills.title')}</h1>
                        <p className="text-xs text-[var(--app-hint)]">{t('skills.subtitle')}</p>
                    </div>
                    <button type="button" onClick={() => void load()} aria-label={t('skills.refresh')} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                        <RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} />
                    </button>
                </div>
            </header>
            <main className="app-scroll-y flex-1 px-3 py-4">
                <div className="mx-auto max-w-[680px] space-y-3">
                    {error ? <p role="alert" className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">{error}</p> : null}
                    {!loading && data?.skills.length === 0 ? <p className="py-10 text-center text-sm text-[var(--app-hint)]">{t('skills.empty')}</p> : null}
                    {data?.skills.map((skill) => (
                        <section key={skill.id} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-sm">
                            <div className="flex items-start gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-[var(--app-link)]"><PackageCheck className="h-5 w-5" /></span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <h2 className="truncate text-sm font-semibold text-[var(--app-fg)]">{skill.name}</h2>
                                        <span className="text-[11px] text-[var(--app-hint)]">v{skill.version}</span>
                                    </div>
                                    <p className="mt-1 text-xs leading-5 text-[var(--app-hint)]">{skill.description}</p>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={skill.enabled}
                                    aria-label={t('skills.toggle', { name: skill.name })}
                                    disabled={pending === `toggle:${skill.id}`}
                                    onClick={() => void setEnabled(skill.id, !skill.enabled)}
                                    className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${skill.enabled ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'}`}
                                >
                                    <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${skill.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                            {skill.enabled ? (
                                <div className="mt-3 border-t border-[var(--app-divider)] pt-2">
                                    {skill.machines.map((machine) => {
                                        const key = `cache:${skill.id}:${machine.machineId}`
                                        const canCache = machine.active && machine.state !== 'ready' && machine.state !== 'unsupported'
                                        return (
                                            <div key={machine.machineId} className="flex min-h-9 items-center gap-2 text-xs">
                                                <span className="min-w-0 flex-1 truncate text-[var(--app-fg)]">{machine.displayName}</span>
                                                <span className={machine.state === 'ready' ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--app-hint)]'}>{stateLabel(machine.state, t)}</span>
                                                {canCache ? <button type="button" onClick={() => void cacheNow(skill.id, machine.machineId)} disabled={pending === key} className="rounded-lg px-2 py-1 font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)] disabled:opacity-50">{pending === key ? '…' : t('skills.cacheNow')}</button> : null}
                                            </div>
                                        )
                                    })}
                                </div>
                            ) : null}
                        </section>
                    ))}
                    <p className="px-1 text-xs leading-5 text-[var(--app-hint)]">{t('skills.hint')}</p>
                </div>
            </main>
        </div>
    )
}
