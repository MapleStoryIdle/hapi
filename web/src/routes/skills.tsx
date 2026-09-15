import { useCallback, useEffect, useState } from 'react'
import { PackageCheck, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ManagedSkillControlResponse } from '@hapi/protocol'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { managedSkillCopy } from '@/lib/managed-skill-copy'
import { useTranslation } from '@/lib/use-translation'

function BackIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

export default function SkillsPage() {
    const { api } = useAppContext()
    const goBack = useAppGoBack()
    const { t, locale } = useTranslation()
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
        const timer = window.setInterval(() => void load(), 30_000)
        return () => window.clearInterval(timer)
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

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="border-b border-[var(--app-border)] px-3 pb-3 pt-[calc(0.625rem+var(--app-safe-area-top))]">
                <div className="mx-auto flex max-w-[680px] items-center gap-3">
                    <button type="button" onClick={goBack} aria-label={t('skills.back')} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]">
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="text-base font-semibold text-[var(--app-fg)]">{t('skills.title')}</h1>
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
                    {data?.skills.map((skill) => {
                        const copy = managedSkillCopy(skill.id, skill, t, locale)
                        return <section key={skill.id} className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-sm">
                            <div className="flex items-start gap-3">
                                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-[var(--app-link)]"><PackageCheck className="h-5 w-5" /></span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <h2 className="truncate text-sm font-semibold text-[var(--app-fg)]">{copy.name}</h2>
                                        <span className="text-[11px] text-[var(--app-hint)]">v{skill.version}</span>
                                        <span className="rounded-full bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">{t(`skills.visibility.${skill.visibility}`)}</span>
                                    </div>
                                    {copy.description ? (
                                        <p className="mt-1 text-xs leading-5 text-[var(--app-hint)]">{copy.description}</p>
                                    ) : null}
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={skill.enabled}
                                    aria-label={t('skills.toggle', { name: copy.name })}
                                    disabled={pending === `toggle:${skill.id}`}
                                    onClick={() => void setEnabled(skill.id, !skill.enabled)}
                                    className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${skill.enabled ? 'bg-[var(--app-link)]' : 'bg-[var(--app-border)]'}`}
                                >
                                    <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${skill.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>
                        </section>
                    })}
                </div>
            </main>
        </div>
    )
}
