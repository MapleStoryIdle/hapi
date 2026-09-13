import { useEffect, useMemo, useState } from 'react'
import type { MonitorConfig, MonitorRequest, MonitorSchedule } from '@hapi/protocol/monitoring'
import { Activity, CalendarClock, ChevronDown, ClipboardPaste, Copy, LoaderCircle, Webhook } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import { MonitorEnabledSwitch } from './MonitorEnabledSwitch'
import { DirectoryPickerDrawer } from '@/components/DirectoryPickerDrawer'
import { AgentSelector } from '@/components/NewSession/AgentSelector'
import { ModelSelector } from '@/components/NewSession/ModelSelector'
import { ReasoningEffortSelector } from '@/components/NewSession/ReasoningEffortSelector'
import type { AgentType } from '@/components/NewSession/types'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useMachines } from '@/hooks/queries/useMachines'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useRecentPaths } from '@/hooks/useRecentPaths'
import {
    createDefaultMonitorConfig,
    createExpiryDraft,
    formatMonitorExpiry,
    resolveExpiryAt,
    type MonitorExpiryDraft
} from './presentation'

type Translate = (key: string, params?: Record<string, string | number>) => string
type HttpRequest = NonNullable<MonitorConfig['request']>
type MonitorReasoningValue = MonitorConfig['reasoningEffort'] | 'default'

function getMachineLabel(machine: { id: string; metadata?: { displayName?: string; host?: string } | null }): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8)
}

function headersToText(headers: Record<string, string>): string {
    return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

/** Parse only a displayed header editor; cURL is parsed by the Hub, never the browser shell. */
export function parseMonitorHeaders(value: string): Record<string, string> {
    const headers: Record<string, string> = {}
    const lines = value.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length > 20) throw new Error('Use at most 20 headers.')
    for (const line of lines) {
        const delimiter = line.indexOf(':')
        if (delimiter <= 0) throw new Error(`Invalid header: ${line}`)
        const name = line.slice(0, delimiter).trim()
        const headerValue = line.slice(delimiter + 1).trim()
        if (!name || name.length > 128 || headerValue.length > 4096) {
            throw new Error(`Invalid header: ${line}`)
        }
        headers[name] = headerValue
    }
    return headers
}

function asHttpRequest(request: MonitorConfig['request']): HttpRequest {
    return request ?? createDefaultMonitorConfig().request!
}

function localTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
        return 'UTC'
    }
}

function createDefaultSchedule(): MonitorSchedule {
    return {
        mode: 'daily',
        time: '09:00',
        dayOfWeek: 1,
        cron: '0 9 * * *',
        timeZone: localTimeZone()
    }
}

function publicWebhookUrl(baseUrl: string): string {
    try {
        const origin = baseUrl || (typeof window === 'undefined' ? 'https://hub.invalid' : window.location.origin)
        return new URL('/hooks/events', origin).toString()
    } catch {
        return '/hooks/events'
    }
}

function requestUpdate<K extends keyof HttpRequest>(request: HttpRequest, key: K, value: HttpRequest[K]): HttpRequest {
    return { ...request, [key]: value }
}

function isMonitorAgent(value: AgentType): value is MonitorConfig['agent'] {
    return value === 'codex' || value === 'claude'
}

export function MonitorForm(props: {
    api: ApiClient
    baseUrl: string
    initialConfig?: MonitorConfig
    /** A source-session binding makes environment and investigation settings server-owned. */
    lockedBinding?: boolean
    /** Existing rules cannot change kind; source-bound creation may still pick a kind. */
    isEditing?: boolean
    submitLabel: string
    savingLabel: string
    onSubmit: (config: MonitorConfig) => Promise<void>
    onCancel?: () => void
    t: Translate
    locale: string
}) {
    const editing = props.isEditing === true
    const [draft, setDraft] = useState<MonitorConfig>(() => props.initialConfig ?? createDefaultMonitorConfig())
    const [headersText, setHeadersText] = useState(() => headersToText(asHttpRequest(props.initialConfig?.request ?? null).headers))
    const [expiry, setExpiry] = useState<MonitorExpiryDraft>(() => createExpiryDraft(props.initialConfig?.expiresAt ?? null, editing))
    const [curl, setCurl] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [isSaving, setIsSaving] = useState(false)
    const [isParsingCurl, setIsParsingCurl] = useState(false)
    const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false)
    const { machines, isLoading: machinesLoading } = useMachines(props.api, true)
    const { getRecentPaths, addRecentPath } = useRecentPaths()
    const { copy } = useCopyToClipboard()
    const lockedBinding = props.lockedBinding ?? Boolean(draft.targetSession)
    const request = asHttpRequest(draft.request)
    const recentPaths = lockedBinding ? [] : getRecentPaths(draft.machineId)
    const webhookUrl = useMemo(() => publicWebhookUrl(props.baseUrl), [props.baseUrl])
    const webhookExample = `${webhookUrl}?token=YOUR_TOKEN`
    const availableMachines = useMemo(() => {
        const active = machines.filter((machine) => machine.active)
        return active.length > 0 ? active : machines
    }, [machines])
    const codexModelsState = useCodexModels({
        api: props.api,
        machineId: draft.machineId,
        enabled: !lockedBinding && draft.agent === 'codex' && Boolean(draft.machineId)
    })
    const selectedModel = draft.model || 'auto'
    const codexModelOptions = useMemo(() => {
        const options = [{ value: 'auto', label: 'Default' }]
        for (const model of codexModelsState.models) options.push({ value: model.id, label: model.displayName })
        if (selectedModel !== 'auto' && !options.some((option) => option.value === selectedModel)) {
            options.splice(1, 0, { value: selectedModel, label: selectedModel })
        }
        return options
    }, [codexModelsState.models, selectedModel])

    useEffect(() => {
        if (lockedBinding || draft.machineId || availableMachines.length === 0) return
        setDraft((current) => current.machineId ? current : { ...current, machineId: availableMachines[0].id })
    }, [availableMachines, draft.machineId, lockedBinding])

    const update = <K extends keyof MonitorConfig>(key: K, value: MonitorConfig[K]) => {
        setDraft((current) => ({ ...current, [key]: value }))
    }

    const updateRequest = <K extends keyof HttpRequest>(key: K, value: HttpRequest[K]) => {
        setDraft((current) => ({ ...current, request: requestUpdate(asHttpRequest(current.request), key, value) }))
    }

    const updateSchedule = (next: Partial<MonitorSchedule>) => {
        setDraft((current) => ({
            ...current,
            schedule: { ...(current.schedule ?? createDefaultSchedule()), ...next }
        }))
    }

    const updateKind = (kind: MonitorConfig['kind']) => {
        setDraft((current) => ({
            ...current,
            kind,
            request: kind === 'http' ? asHttpRequest(current.request) : null,
            schedule: kind === 'scheduled' ? current.schedule ?? createDefaultSchedule() : undefined
        }))
    }

    const updateAgent = (agent: AgentType) => {
        if (!isMonitorAgent(agent)) return
        setDraft((current) => {
            if (current.agent === agent) return current
            const permissionMode = agent === 'codex'
                ? current.permissionMode === 'plan' ? 'read-only' : current.permissionMode
                : current.permissionMode === 'read-only' ? 'plan' : current.permissionMode
            return { ...current, agent, permissionMode, model: '', reasoningEffort: '' }
        })
    }

    const importCurl = async () => {
        if (!curl.trim() || isParsingCurl) return
        setError(null)
        setNotice(null)
        setIsParsingCurl(true)
        try {
            const result = await props.api.parseMonitorCurl(curl)
            if (!/^https?:$/i.test(new URL(result.request.url).protocol)) {
                throw new Error(props.t('monitors.form.curlHttpOnly'))
            }
            const parsedRequest: HttpRequest = { ...result.request, allowPrivateNetwork: false, allowPost: false }
            setDraft((current) => ({ ...current, kind: 'http', request: parsedRequest, schedule: undefined }))
            setHeadersText(headersToText(parsedRequest.headers))
            setCurl('')
            setNotice(props.t('monitors.form.curlImported'))
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : props.t('monitors.form.curlFailed'))
        } finally {
            setIsParsingCurl(false)
        }
    }

    const buildConfig = (): MonitorConfig => {
        const name = draft.name.trim()
        const directory = draft.directory.trim()
        const prompt = draft.prompt.trim()
        if (!name) throw new Error(props.t('monitors.form.errorName'))
        // Bound forms may carry placeholders: the Hub resolves the canonical
        // environment just before it validates and saves the configuration.
        if (!lockedBinding && !draft.machineId) throw new Error(props.t('monitors.form.errorMachine'))
        if (!lockedBinding && !directory) throw new Error(props.t('monitors.form.errorDirectory'))
        if (!prompt) throw new Error(props.t('monitors.form.errorPrompt'))

        const common = {
            ...draft,
            name,
            directory,
            model: draft.model.trim(),
            prompt,
            expiresAt: resolveExpiryAt(expiry)
        }
        if (draft.kind === 'webhook') return { ...common, request: null, schedule: undefined }
        if (draft.kind === 'scheduled') {
            const schedule = draft.schedule ?? createDefaultSchedule()
            const normalizedSchedule: MonitorSchedule = {
                ...schedule,
                time: schedule.time.trim(),
                cron: schedule.cron.trim(),
                timeZone: schedule.timeZone.trim()
            }
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedSchedule.time)) throw new Error(props.t('monitors.form.errorScheduleTime'))
            if (normalizedSchedule.mode === 'weekly' && (!Number.isInteger(normalizedSchedule.dayOfWeek) || normalizedSchedule.dayOfWeek < 0 || normalizedSchedule.dayOfWeek > 6)) throw new Error(props.t('monitors.form.errorScheduleDay'))
            if (normalizedSchedule.mode === 'cron' && !normalizedSchedule.cron) throw new Error(props.t('monitors.form.errorScheduleCron'))
            if (!normalizedSchedule.timeZone) throw new Error(props.t('monitors.form.errorScheduleTimeZone'))
            return { ...common, request: null, schedule: normalizedSchedule }
        }
        const headers = parseMonitorHeaders(headersText)
        if (!/^https?:$/i.test(new URL(request.url).protocol)) throw new Error(props.t('monitors.form.errorHttpUrl'))
        if (!Number.isInteger(request.intervalSeconds) || request.intervalSeconds < 60) throw new Error(props.t('monitors.form.errorInterval'))
        if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 30) throw new Error(props.t('monitors.form.errorTimeout'))
        if (!Number.isInteger(request.expectedStatus) || request.expectedStatus < 100 || request.expectedStatus > 599) throw new Error(props.t('monitors.form.errorStatus'))
        if (request.method === 'POST' && !request.allowPost) throw new Error(props.t('monitors.form.errorPostConsent'))
        return { ...common, schedule: undefined, request: { ...request, headers } }
    }

    const save = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (isSaving) return
        setError(null)
        setNotice(null)
        try {
            const config = buildConfig()
            setIsSaving(true)
            await props.onSubmit(config)
            if (config.machineId && config.directory) addRecentPath(config.machineId, config.directory)
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : props.t('dialog.error.default'))
        } finally {
            setIsSaving(false)
        }
    }

    const selectedExpiryValue = expiry.mode
    const expiryLabel = expiry.mode === 'preserve'
        ? `${props.t('monitors.form.expiryPreserve')} (${formatMonitorExpiry(expiry.expiresAt, props.locale)})`
        : undefined
    const schedule = draft.schedule ?? createDefaultSchedule()
    const modelOptions = draft.agent === 'codex' ? codexModelOptions : undefined
    const reasoningValue: MonitorReasoningValue = draft.reasoningEffort || 'default'
    const reasoningOptions: Array<{ value: MonitorReasoningValue; label: string }> = [
        { value: 'default', label: props.t('monitors.form.default') },
        { value: 'none' as MonitorReasoningValue, label: props.t('monitors.reasoning.none') },
        { value: 'minimal' as MonitorReasoningValue, label: props.t('monitors.reasoning.minimal') },
        { value: 'low' as MonitorReasoningValue, label: props.t('monitors.reasoning.low') },
        { value: 'medium' as MonitorReasoningValue, label: props.t('monitors.reasoning.medium') },
        { value: 'high' as MonitorReasoningValue, label: props.t('monitors.reasoning.high') },
        { value: 'xhigh' as MonitorReasoningValue, label: props.t('monitors.reasoning.xhigh') },
        { value: 'max' as MonitorReasoningValue, label: props.t('monitors.reasoning.max') },
        { value: 'ultra' as MonitorReasoningValue, label: props.t('monitors.reasoning.ultra') }
    ]
    const kindOptions = [
        { kind: 'http' as const, Icon: Activity, label: props.t('monitors.kind.probe') },
        { kind: 'webhook' as const, Icon: Webhook, label: props.t('monitors.kind.webhookTab') },
        { kind: 'scheduled' as const, Icon: CalendarClock, label: props.t('monitors.kind.scheduled') }
    ]

    return (
        <>
            <form onSubmit={save} className="space-y-4" noValidate>
                {error ? <div role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error}</div> : null}
                {notice ? <div role="status" className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">{notice}</div> : null}

                <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
                    <h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.basics')}</h2>
                    <div className="mt-3 space-y-3">
                        <fieldset>
                            <legend className="text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.kind')}</legend>
                            <div className="mt-1 grid grid-cols-3 gap-2" role="radiogroup" aria-label={props.t('monitors.form.kind')}>
                                {kindOptions.map(({ kind, Icon, label }) => {
                                    const selected = draft.kind === kind
                                    return <label key={kind} className={`flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-center text-xs font-semibold transition-colors ${selected ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]' : 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]'} ${editing ? 'cursor-not-allowed opacity-60' : ''}`}><input type="radio" name="monitor-kind" checked={selected} onChange={() => updateKind(kind)} disabled={editing} className="sr-only" /><Icon className="h-4 w-4" aria-hidden="true" /><span>{label}</span></label>
                                })}
                            </div>
                        </fieldset>
                        <label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.name')}<input value={draft.name} onChange={(event) => update('name', event.target.value)} maxLength={100} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label>
                    </div>
                </section>

                {!lockedBinding ? <EnvironmentSection draft={draft} update={update} machinesLoading={machinesLoading} availableMachines={availableMachines} recentPaths={recentPaths} t={props.t} onBrowse={() => setDirectoryBrowserOpen(true)} /> : <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.boundSession')}</h2></section>}

                {draft.kind === 'http' ? <HttpSection request={request} headersText={headersText} curl={curl} editing={editing} isParsingCurl={isParsingCurl} t={props.t} onHeadersChange={setHeadersText} onCurlChange={setCurl} onImport={() => void importCurl()} onRequestChange={updateRequest} /> : null}
                {draft.kind === 'webhook' ? <WebhookSection example={webhookExample} t={props.t} onCopy={() => void copy(webhookExample)} /> : null}
                {draft.kind === 'scheduled' ? <ScheduledSection schedule={schedule} t={props.t} onChange={updateSchedule} /> : null}

                {!lockedBinding ? <InvestigationSection draft={draft} selectedModel={selectedModel} modelOptions={modelOptions} modelsLoading={codexModelsState.isLoading} modelsError={codexModelsState.error} reasoningValue={reasoningValue} reasoningOptions={reasoningOptions} isSaving={isSaving} t={props.t} onAgentChange={updateAgent} onUpdate={update} /> : null}
                <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.presetPrompt')}</h2><label className="mt-3 block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.prompt')}<textarea value={draft.prompt} onChange={(event) => update('prompt', event.target.value)} rows={5} maxLength={8000} className="mt-1 w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm leading-6 text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label></section>

                <ExpirySection draft={draft} editing={editing} expiry={expiry} expiryLabel={expiryLabel} initialExpiresAt={props.initialConfig?.expiresAt ?? null} t={props.t} onExpiryChange={setExpiry} />
                <section className="grid grid-cols-2 gap-4 rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2">
                    <MonitorEnabledSwitch enabled={draft.enabled} disabled={isSaving} label={props.t('monitors.form.enabled')} onChange={enabled => update('enabled', enabled)} />
                    <MonitorEnabledSwitch enabled={draft.notificationsEnabled !== false} disabled={isSaving} label={props.t('monitors.form.notifications')} onChange={enabled => update('notificationsEnabled', enabled)} />
                </section>
                <div className="grid grid-flow-col auto-cols-fr gap-2 pb-2">{props.onCancel ? <button type="button" onClick={props.onCancel} disabled={isSaving} className="h-11 rounded-xl border border-[var(--app-border)] px-4 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{props.t('button.cancel')}</button> : null}<button type="submit" disabled={isSaving} className="h-11 rounded-xl bg-[var(--app-button)] px-4 text-sm font-semibold text-[var(--app-button-text)] transition-opacity hover:opacity-85 disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{isSaving ? props.savingLabel : props.submitLabel}</button></div>
            </form>

            <DirectoryPickerDrawer open={directoryBrowserOpen} onOpenChange={setDirectoryBrowserOpen} api={props.api} machines={availableMachines} machinesLoading={machinesLoading} initialMachineId={draft.machineId || undefined} onSelect={(machineId, directory) => setDraft((current) => ({ ...current, machineId, directory }))} />
        </>
    )
}

function EnvironmentSection(props: {
    draft: MonitorConfig
    update: <K extends keyof MonitorConfig>(key: K, value: MonitorConfig[K]) => void
    machinesLoading: boolean
    availableMachines: Array<{ id: string; active: boolean; metadata?: { displayName?: string; host?: string } | null }>
    recentPaths: string[]
    t: Translate
    onBrowse: () => void
}) {
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.environment')}</h2><div className="mt-3 space-y-3"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.machine')}<span className="relative mt-1 block"><select value={props.draft.machineId} onChange={(event) => props.update('machineId', event.target.value)} disabled={props.machinesLoading || props.availableMachines.length === 0} className="h-11 w-full appearance-none rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 pr-10 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"><option value="">{props.machinesLoading ? props.t('loading.machines') : props.t('monitors.form.chooseMachine')}</option>{props.availableMachines.map((machine) => <option key={machine.id} value={machine.id}>{getMachineLabel(machine)}{machine.active ? '' : ` (${props.t('monitors.status.runnerOffline')})`}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-hint)]" aria-hidden="true" /></span></label><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.directory')}<div className="mt-1 flex gap-2"><input value={props.draft.directory} onChange={(event) => props.update('directory', event.target.value)} maxLength={2048} className="h-11 min-w-0 flex-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /><button type="button" onClick={props.onBrowse} disabled={props.machinesLoading || props.availableMachines.length === 0} className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-xs font-semibold text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{props.t('monitors.form.browseDirectory')}</button></div></label>{props.recentPaths.length > 0 ? <div><p className="text-[11px] font-medium text-[var(--app-hint)]">{props.t('monitors.form.recentPaths')}</p><div className="mt-1 flex flex-wrap gap-1.5">{props.recentPaths.map((path) => <button key={path} type="button" onClick={() => props.update('directory', path)} className="max-w-full rounded-lg bg-[var(--app-subtle-bg)] px-2 py-1.5 text-left text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" title={path}><span className="block max-w-[18rem] truncate" dir="rtl"><span dir="ltr">{path}</span></span></button>)}</div></div> : null}</div></section>
}

function HttpSection(props: {
    request: HttpRequest
    headersText: string
    curl: string
    editing: boolean
    isParsingCurl: boolean
    t: Translate
    onHeadersChange: (value: string) => void
    onCurlChange: (value: string) => void
    onImport: () => void
    onRequestChange: <K extends keyof HttpRequest>(key: K, value: HttpRequest[K]) => void
}) {
    const update = props.onRequestChange
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><div><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.httpRequest')}</h2></div><div className="mt-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-2.5"><label className="block text-xs font-medium text-[var(--app-hint)]" htmlFor="monitor-curl">{props.t('monitors.form.importCurl')}</label><textarea id="monitor-curl" value={props.curl} onChange={(event) => props.onCurlChange(event.target.value)} rows={3} placeholder="curl https://service.example/health" className="mt-1 w-full resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-xs text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /><button type="button" onClick={props.onImport} disabled={!props.curl.trim() || props.isParsingCurl || props.editing} className="mt-2 inline-flex h-11 items-center gap-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><span aria-hidden="true">{props.isParsingCurl ? <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ClipboardPaste className="h-4 w-4" />}</span>{props.isParsingCurl ? props.t('monitors.form.parsingCurl') : props.t('monitors.form.parseCurl')}</button></div><div className="mt-3 grid gap-3 sm:grid-cols-[7.5rem_minmax(0,1fr)]"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.method')}<select value={props.request.method} onChange={(event) => update('method', event.target.value as HttpRequest['method'])} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><option value="GET">GET</option><option value="HEAD">HEAD</option><option value="POST">POST</option></select></label><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.url')}<input type="url" value={props.request.url} onChange={(event) => update('url', event.target.value)} maxLength={2048} placeholder="https://service.example/health" className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label></div><label className="mt-3 block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.headers')}<textarea value={props.headersText} onChange={(event) => props.onHeadersChange(event.target.value)} rows={3} placeholder="Accept: application/json" className="mt-1 w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-xs text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label>{props.request.method === 'POST' ? <><label className="mt-3 block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.body')}<textarea value={props.request.body} onChange={(event) => update('body', event.target.value)} rows={3} maxLength={8192} className="mt-1 w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 font-mono text-xs text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label><label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-amber-400/50 bg-amber-500/10 p-3 text-sm text-[var(--app-fg)]"><input type="checkbox" checked={props.request.allowPost} onChange={(event) => update('allowPost', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-[var(--app-border)] accent-amber-600" /><span><span className="font-semibold">{props.t('monitors.form.allowPost')}</span><span className="mt-0.5 block text-xs leading-5 text-[var(--app-hint)]">{props.t('monitors.form.allowPostHint')}</span></span></label></> : null}<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.interval')}<input type="number" min={60} max={86400} value={props.request.intervalSeconds} onChange={(event) => update('intervalSeconds', Number(event.target.value))} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.timeout')}<input type="number" min={1} max={30} value={props.request.timeoutSeconds} onChange={(event) => update('timeoutSeconds', Number(event.target.value))} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.expectedStatus')}<input type="number" min={100} max={599} value={props.request.expectedStatus} onChange={(event) => update('expectedStatus', Number(event.target.value))} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label></div><label className="mt-3 block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.bodyIncludes')}<input value={props.request.bodyIncludes} onChange={(event) => update('bodyIncludes', event.target.value)} maxLength={1000} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label><label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-3 text-sm text-[var(--app-fg)]"><input type="checkbox" checked={props.request.allowPrivateNetwork} onChange={(event) => update('allowPrivateNetwork', event.target.checked)} className="mt-0.5 h-4 w-4 rounded border-[var(--app-border)] accent-[var(--app-link)]" /><span><span className="font-semibold">{props.t('monitors.form.allowPrivateNetwork')}</span><span className="mt-0.5 block text-xs leading-5 text-[var(--app-hint)]">{props.t('monitors.form.allowPrivateNetworkHint')}</span></span></label></section>
}

function WebhookSection(props: { example: string; t: Translate; onCopy: () => void }) {
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.webhook')}</h2></div><button type="button" onClick={props.onCopy} aria-label={props.t('monitors.form.copyWebhook')} title={props.t('monitors.form.copyWebhook')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><Copy className="h-4 w-4" aria-hidden="true" /></button></div><pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 text-xs leading-5 text-[var(--app-fg)]"><code>{`POST ${props.example}\nContent-Type: application/json\n\n{"prompt":"YOUR_PROMPT","data":{"key":"value"}}`}</code></pre></section>
}

function ScheduledSection(props: { schedule: MonitorSchedule; t: Translate; onChange: (next: Partial<MonitorSchedule>) => void }) {
    const schedule = props.schedule
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.scheduledRun')}</h2><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.scheduleMode')}<select value={schedule.mode} onChange={(event) => props.onChange({ mode: event.target.value as MonitorSchedule['mode'] })} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><option value="daily">{props.t('monitors.schedule.daily')}</option><option value="weekly">{props.t('monitors.schedule.weekly')}</option><option value="cron">{props.t('monitors.schedule.cron')}</option></select></label><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.timeZone')}<input value={schedule.timeZone} onChange={(event) => props.onChange({ timeZone: event.target.value })} placeholder="Asia/Shanghai" className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label></div>{schedule.mode !== 'cron' ? <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.scheduleTime')}<input type="time" value={schedule.time} onChange={(event) => props.onChange({ time: event.target.value })} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label>{schedule.mode === 'weekly' ? <label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.scheduleDay')}<select value={schedule.dayOfWeek} onChange={(event) => props.onChange({ dayOfWeek: Number(event.target.value) })} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><option value={0}>{props.t('monitors.day.sunday')}</option><option value={1}>{props.t('monitors.day.monday')}</option><option value={2}>{props.t('monitors.day.tuesday')}</option><option value={3}>{props.t('monitors.day.wednesday')}</option><option value={4}>{props.t('monitors.day.thursday')}</option><option value={5}>{props.t('monitors.day.friday')}</option><option value={6}>{props.t('monitors.day.saturday')}</option></select></label> : null}</div> : <label className="mt-3 block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.scheduleCron')}<input value={schedule.cron} onChange={(event) => props.onChange({ cron: event.target.value })} placeholder="0 9 * * 1-5" className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 font-mono text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label>}</section>
}

function InvestigationSection(props: {
    draft: MonitorConfig
    selectedModel: string
    modelOptions?: Array<{ value: string; label: string }>
    modelsLoading: boolean
    modelsError: string | null
    reasoningValue: MonitorReasoningValue
    reasoningOptions: Array<{ value: MonitorReasoningValue; label: string }>
    isSaving: boolean
    t: Translate
    onAgentChange: (agent: AgentType) => void
    onUpdate: <K extends keyof MonitorConfig>(key: K, value: MonitorConfig[K]) => void
}) {
    return <AgentSelector agent={props.draft.agent} isDisabled={props.isSaving} onAgentChange={props.onAgentChange}><ModelSelector agent={props.draft.agent} model={props.selectedModel} options={props.modelOptions} isDisabled={props.isSaving || props.draft.agent === 'codex' && Boolean(props.modelsError)} isLoading={props.draft.agent === 'codex' && props.modelsLoading} error={props.draft.agent === 'codex' && props.modelsError ? `${props.t('newSession.model.loadFailed')}: ${props.modelsError}` : null} inline onModelChange={(value) => props.onUpdate('model', value === 'auto' ? '' : value)} /><ReasoningEffortSelector agent={props.draft.agent} value={props.reasoningValue} codexOptions={props.reasoningOptions} isDisabled={props.isSaving} inline onChange={(value) => props.onUpdate('reasoningEffort', value === 'default' ? '' : value as MonitorConfig['reasoningEffort'])} /><label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.permissionMode')}<select value={props.draft.permissionMode} onChange={(event) => props.onUpdate('permissionMode', event.target.value as MonitorConfig['permissionMode'])} className="h-11 w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 font-sans text-sm text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><option value="default">{props.t('monitors.permission.default')}</option>{props.draft.agent === 'codex' ? <option value="read-only">{props.t('monitors.permission.readOnly')}</option> : <option value="plan">{props.t('monitors.permission.plan')}</option>}</select></label></AgentSelector>
}

function ExpirySection(props: {
    draft: MonitorConfig
    editing: boolean
    expiry: MonitorExpiryDraft
    expiryLabel?: string
    initialExpiresAt: number | null
    t: Translate
    onExpiryChange: (expiry: MonitorExpiryDraft) => void
}) {
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]"><h2 className="text-sm font-semibold text-[var(--app-fg)]">{props.t('monitors.form.schedule')}</h2><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.expiry')}<select value={props.expiry.mode} onChange={(event) => { const mode = event.target.value as MonitorExpiryDraft['mode']; props.onExpiryChange(mode === 'preserve' ? { mode: 'preserve', expiresAt: props.initialExpiresAt } : mode === 'custom-days' ? { mode, days: '14' } : { mode } as MonitorExpiryDraft) }} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">{props.editing ? <option value="preserve">{props.expiryLabel}</option> : null}<option value="one-day">{props.t('monitors.form.expiryOneDay')}</option><option value="seven-days">{props.t('monitors.form.expirySevenDays')}</option><option value="custom-days">{props.t('monitors.form.expiryCustom')}</option><option value="permanent">{props.t('monitors.form.expiryPermanent')}</option></select></label>{props.expiry.mode === 'custom-days' ? <label className="block text-xs font-medium text-[var(--app-hint)]">{props.t('monitors.form.customDays')}<input type="number" min={1} step={1} value={props.expiry.days} onChange={(event) => props.onExpiryChange({ mode: 'custom-days', days: event.target.value })} className="mt-1 h-11 w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-base text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" /></label> : null}</div></section>
}
