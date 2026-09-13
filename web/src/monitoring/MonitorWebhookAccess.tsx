import { useEffect, useState } from 'react'
import type { ApiClient } from '@/api/client'
import { MonitorTokenReveal } from './MonitorTokenReveal'

export function MonitorWebhookAccess(props: { api: ApiClient; monitorId: string; baseUrl: string; t: (key: string) => string; onRotate: () => void; isRotating?: boolean }) {
    const [token, setToken] = useState<string | null>(null)
    const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        let cancelled = false
        setToken(null)
        setState('loading')
        void props.api.getMonitorToken(props.monitorId).then(result => {
            if (!cancelled) { setToken(result.token); setState('ready') }
        }).catch(() => { if (!cancelled) setState('error') })
        return () => { cancelled = true }
    }, [props.api, props.monitorId, attempt])
    if (token) return <MonitorTokenReveal token={token} baseUrl={props.baseUrl} t={props.t} onRotate={props.onRotate} isRotating={props.isRotating} />
    return <div className="rounded-2xl border border-[var(--app-border)] p-4 text-sm">
        {props.t(state === 'loading' ? 'loading' : state === 'error' ? 'monitors.copy.failed' : 'monitors.token.legacy')}
        {state !== 'loading' ? <button type="button" onClick={state === 'error' ? () => setAttempt(value => value + 1) : props.onRotate} className="ml-2 min-h-11 px-3 text-[var(--app-link)]">{props.t(state === 'error' ? 'monitors.refresh' : 'monitors.token.rotate')}</button> : null}
    </div>
}
