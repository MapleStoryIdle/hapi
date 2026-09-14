import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Activity, AlertTriangle, CheckCircle2, Clock3, FileSearch, Gauge, RefreshCw, Search, Sparkles } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { OpenVikingMetricsResponse, OpenVikingQualityResponse, OpenVikingSearchResponse } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

type Tab = 'overview' | 'search' | 'quality' | 'files'

function Metric(props: { label: string; value: string; tone?: 'good' | 'warning' }) {
    return <div className="min-w-0 px-4 py-3">
        <div className={`text-[24px] font-semibold tabular-nums ${props.tone === 'warning' ? 'text-amber-500' : props.tone === 'good' ? 'text-emerald-500' : 'text-[var(--app-fg)]'}`}>{props.value}</div>
        <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">{props.label}</div>
    </div>
}

function errorCard(message: string, retry: () => void, retryLabel: string) {
    return <div className="rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] p-5 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-7 w-7 text-amber-500" aria-hidden="true" />
        <p className="mt-3 [overflow-wrap:anywhere] text-sm leading-5 text-[var(--app-hint)]">{message}</p>
        <button type="button" onClick={retry} className="mt-4 min-h-11 rounded-full bg-[var(--app-link)] px-5 text-sm font-semibold text-white">{retryLabel}</button>
    </div>
}

export function OpenVikingPluginDashboard(props: { api: ApiClient; machineId: string; files: ReactNode }) {
    const { t } = useTranslation()
    const [tab, setTab] = useState<Tab>('overview')
    const [metrics, setMetrics] = useState<OpenVikingMetricsResponse | null>(null)
    const [metricsLoading, setMetricsLoading] = useState(false)
    const [query, setQuery] = useState('')
    const [searchResult, setSearchResult] = useState<OpenVikingSearchResponse | null>(null)
    const [searching, setSearching] = useState(false)
    const [quality, setQuality] = useState<OpenVikingQualityResponse | null>(null)
    const [qualityLoading, setQualityLoading] = useState(false)

    const loadMetrics = useCallback(async () => {
        setMetricsLoading(true)
        try { setMetrics(await props.api.getOpenVikingMetrics(props.machineId)) }
        catch (error) { setMetrics({ ok: false, error: error instanceof Error ? error.message : t('openViking.metricsFailed') }) }
        finally { setMetricsLoading(false) }
    }, [props.api, props.machineId, t])

    useEffect(() => {
        setMetrics(null)
        setSearchResult(null)
        setQuality(null)
        void loadMetrics()
    }, [loadMetrics])

    const submitSearch = async (event: FormEvent) => {
        event.preventDefault()
        const value = query.trim()
        if (!value || searching) return
        setSearching(true)
        setSearchResult(null)
        try { setSearchResult(await props.api.searchOpenViking(props.machineId, value)) }
        catch (error) { setSearchResult({ ok: false, error: error instanceof Error ? error.message : t('openViking.searchFailed') }) }
        finally { setSearching(false) }
    }

    const scanQuality = async () => {
        if (qualityLoading) return
        setQualityLoading(true)
        try { setQuality(await props.api.getOpenVikingQuality(props.machineId)) }
        catch (error) { setQuality({ ok: false, error: error instanceof Error ? error.message : t('openViking.qualityFailed') }) }
        finally { setQualityLoading(false) }
    }

    const tabs: Array<{ id: Tab; label: string }> = [
        { id: 'overview', label: t('openViking.tab.overview') },
        { id: 'search', label: t('openViking.tab.search') },
        { id: 'quality', label: t('openViking.tab.quality') },
        { id: 'files', label: t('openViking.tab.files') }
    ]
    const metricsError = metrics?.error?.toLowerCase().includes('metrics are disabled')
        ? t('openViking.metricsDisabled')
        : metrics?.error ?? t('openViking.metricsFailed')

    return <>
        <div className="grid grid-cols-4 rounded-[12px] bg-[var(--app-subtle-bg)] p-1" role="tablist" aria-label={t('openViking.pluginSections')}>
            {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => setTab(item.id)} className={`min-h-9 rounded-[9px] px-1 text-[13px] font-medium transition-all ${tab === item.id ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm' : 'text-[var(--app-hint)]'}`}>{item.label}</button>)}
        </div>

        {tab === 'overview' ? <div className="space-y-4" role="tabpanel">
            {metricsLoading && !metrics ? <div className="session-list-skeleton h-44 rounded-[18px]" /> : metrics?.ok ? <>
                <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                    <div className="flex min-h-13 items-center gap-3 border-b border-[var(--app-divider)] px-4">
                        <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[color-mix(in_srgb,var(--app-link)_12%,transparent)] text-[var(--app-link)]"><Activity className="h-[18px] w-[18px]" aria-hidden="true" /></span>
                        <h2 className="min-w-0 flex-1 text-[16px] font-semibold">{t('openViking.retrievalHealth')}</h2>
                        <button type="button" onClick={() => void loadMetrics()} disabled={metricsLoading} className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--app-link)] disabled:opacity-40" aria-label={t('openViking.refreshMetrics')}><RefreshCw className={`h-[18px] w-[18px] ${metricsLoading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" /></button>
                    </div>
                    <div className="grid grid-cols-2 divide-x divide-y divide-[var(--app-divider)]">
                        <Metric label={t('openViking.metric.requests')} value={`${metrics.retrievalRequests ?? 0}`} />
                        <Metric label={t('openViking.metric.zeroRate')} value={`${((metrics.zeroResultRate ?? 0) * 100).toFixed(1)}%`} tone={(metrics.zeroResultRate ?? 0) > 0.15 ? 'warning' : 'good'} />
                        <Metric label={t('openViking.metric.averageLatency')} value={metrics.averageLatencyMs === undefined ? '—' : `${Math.round(metrics.averageLatencyMs)} ms`} />
                        <Metric label={t('openViking.metric.p95Latency')} value={metrics.p95LatencyMs === undefined ? '—' : `${Math.round(metrics.p95LatencyMs)} ms`} />
                    </div>
                </section>
                <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                    <div className="grid grid-cols-2 divide-x divide-[var(--app-divider)]">
                        <Metric label={t('openViking.metric.rerankFallback')} value={`${metrics.rerankFallbacks ?? 0}`} tone={(metrics.rerankFallbacks ?? 0) > 0 ? 'warning' : undefined} />
                        <Metric label={t('openViking.metric.queue')} value={`${(metrics.queuePending ?? 0) + (metrics.queueInProgress ?? 0)}`} tone={(metrics.queuePending ?? 0) > 0 ? 'warning' : undefined} />
                    </div>
                </section>
            </> : metrics ? errorCard(metricsError, () => void loadMetrics(), t('openViking.retry')) : null}
        </div> : null}

        {tab === 'search' ? <div className="space-y-4" role="tabpanel">
            <form onSubmit={(event) => void submitSearch(event)} className="rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-sm">
                <label className="sr-only" htmlFor="openviking-search-query">{t('openViking.searchQuery')}</label>
                <div className="flex min-h-12 items-center gap-2 rounded-[13px] bg-[var(--app-secondary-bg)] px-3 focus-within:ring-2 focus-within:ring-[var(--app-link)]">
                    <Search className="h-5 w-5 shrink-0 text-[var(--app-hint)]" aria-hidden="true" />
                    <input id="openviking-search-query" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('openViking.searchPlaceholder')} className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-[var(--app-hint)]" />
                    <button type="submit" disabled={!query.trim() || searching} className="min-h-9 rounded-full bg-[var(--app-link)] px-4 text-sm font-semibold text-white disabled:opacity-40">{searching ? t('openViking.searching') : t('openViking.searchAction')}</button>
                </div>
            </form>
            {searchResult?.ok ? <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">
                <div className="flex min-h-12 items-center gap-2 border-b border-[var(--app-divider)] px-4 text-sm text-[var(--app-hint)]"><FileSearch className="h-4 w-4" aria-hidden="true" /><span>{t('openViking.searchSummary', { count: searchResult.total ?? 0, duration: searchResult.durationMs ?? 0 })}</span></div>
                {(searchResult.hits ?? []).length ? (searchResult.hits ?? []).map((hit, index) => <div key={`${hit.uri}-${index}`} className={`px-4 py-3 ${index ? 'border-t border-[var(--app-divider)]' : ''}`}>
                    <div className="flex items-start gap-3"><span className="mt-0.5 flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--app-secondary-bg)] px-2 text-xs font-semibold tabular-nums text-[var(--app-link)]">{hit.score === undefined ? '—' : hit.score.toFixed(2)}</span><div className="min-w-0 flex-1"><div className="truncate text-[15px] font-medium" title={hit.uri}>{hit.uri}</div>{hit.abstract ? <p className="mt-1 line-clamp-3 text-sm leading-5 text-[var(--app-hint)]">{hit.abstract}</p> : null}{hit.matchReason ? <p className="mt-1 text-xs text-[var(--app-hint)]">{hit.matchReason}</p> : null}</div></div>
                </div>) : <div className="px-4 py-10 text-center text-sm text-[var(--app-hint)]">{t('openViking.noSearchResults')}</div>}
            </section> : searchResult ? errorCard(searchResult.error ?? t('openViking.searchFailed'), () => setSearchResult(null), t('openViking.retry')) : null}
        </div> : null}

        {tab === 'quality' ? <div className="space-y-4" role="tabpanel">
            {!quality ? <section className="flex min-h-56 flex-col items-center justify-center rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] px-6 text-center shadow-sm"><span className="flex h-14 w-14 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-link)_10%,transparent)] text-[var(--app-link)]"><Sparkles className="h-7 w-7" aria-hidden="true" /></span><h2 className="mt-4 text-[17px] font-semibold">{t('openViking.qualityTitle')}</h2><p className="mt-1 max-w-sm text-sm leading-5 text-[var(--app-hint)]">{t('openViking.qualityBody')}</p><button type="button" onClick={() => void scanQuality()} disabled={qualityLoading} className="mt-5 min-h-11 rounded-full bg-[var(--app-link)] px-5 text-sm font-semibold text-white disabled:opacity-40">{qualityLoading ? t('openViking.scanning') : t('openViking.scanNow')}</button></section>
                : quality.ok ? <>
                    <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm"><div className="grid grid-cols-3 divide-x divide-[var(--app-divider)]"><Metric label={t('openViking.quality.scanned')} value={`${quality.scannedMemories ?? 0}`} /><Metric label={t('openViking.quality.duplicates')} value={`${quality.duplicateGroups ?? 0}`} tone={(quality.duplicateGroups ?? 0) > 0 ? 'warning' : 'good'} /><Metric label={t('openViking.quality.conflicts')} value={`${quality.conflictGroups ?? 0}`} tone={(quality.conflictGroups ?? 0) > 0 ? 'warning' : 'good'} /></div><div className="grid grid-cols-2 divide-x divide-[var(--app-divider)] border-t border-[var(--app-divider)]"><Metric label={t('openViking.quality.stale7d')} value={`${quality.stale7d ?? 0}`} /><Metric label={t('openViking.quality.stale30d')} value={`${quality.stale30d ?? 0}`} /></div></section>
                    <section className="overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm">{(quality.issues ?? []).length ? (quality.issues ?? []).map((issue, index) => <div key={`${issue.kind}-${index}`} className={`flex gap-3 px-4 py-3 ${index ? 'border-t border-[var(--app-divider)]' : ''}`}>{issue.kind === 'duplicate' ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />}<div className="min-w-0"><div className="text-[15px] font-medium">{issue.kind === 'duplicate' ? t('openViking.duplicateCandidate') : t('openViking.conflictCandidate')}</div><div className="mt-0.5 truncate text-sm text-[var(--app-hint)]" title={issue.summary}>{issue.summary}</div></div></div>) : <div className="flex min-h-24 items-center justify-center gap-2 px-4 text-sm text-emerald-600"><CheckCircle2 className="h-5 w-5" aria-hidden="true" />{t('openViking.noQualityIssues')}</div>}</section>
                    <button type="button" onClick={() => void scanQuality()} disabled={qualityLoading} className="mx-auto flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-medium text-[var(--app-link)] disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${qualityLoading ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />{t('openViking.scanAgain')}</button>
                </> : errorCard(quality.error ?? t('openViking.qualityFailed'), () => void scanQuality(), t('openViking.retry'))}
        </div> : null}

        {tab === 'files' ? <div role="tabpanel">{props.files}</div> : null}
    </>
}
