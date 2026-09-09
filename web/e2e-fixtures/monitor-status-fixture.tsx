/* Isolated mobile visual fixture for the 7-day monitor timelines. */
import React from 'react'
import ReactDOM from 'react-dom/client'
import type { Monitor, MonitorConfig } from '@hapi/protocol/monitoring'
import '../src/index.css'
import { en } from '../src/lib/locales'
import { MonitorStatusTimeline } from '../src/monitoring/MonitorStatusTimeline'

const HOUR_MS = 60 * 60 * 1000
const now = Date.now()

function config(kind: MonitorConfig['kind']): MonitorConfig {
    return {
        name: kind === 'http' ? 'Checkout API' : 'Deployment events',
        kind,
        machineId: 'fixture-machine',
        directory: '/workspace/fixture',
        agent: 'codex',
        model: '',
        reasoningEffort: '',
        permissionMode: 'read-only',
        prompt: 'Fixture only.',
        expiresAt: null,
        enabled: true,
        request: kind === 'http' ? {
            url: 'https://checkout.example.test/health',
            method: 'GET',
            headers: {},
            body: '',
            intervalSeconds: 300,
            timeoutSeconds: 10,
            expectedStatus: 200,
            bodyIncludes: '',
            allowPrivateNetwork: false,
            allowPost: false
        } : null
    }
}

const httpMonitor: Pick<Monitor, 'config' | 'buckets'> = {
    config: config('http'),
    buckets: [
        { at: now - 8 * HOUR_MS, total: 3, ok: 3, failures: 0, latencyMs: 240 },
        { at: now - 5 * HOUR_MS, total: 3, ok: 2, failures: 1, latencyMs: 420 },
        { at: now - 2 * HOUR_MS, total: 2, ok: 0, failures: 2, latencyMs: 0 }
    ]
}

const webhookMonitor: Pick<Monitor, 'config' | 'buckets'> = {
    config: config('webhook'),
    buckets: [
        { at: now - 7 * HOUR_MS, total: 2, ok: 2, failures: 0, latencyMs: 0 },
        { at: now - HOUR_MS, total: 1, ok: 1, failures: 0, latencyMs: 0 }
    ]
}

function t(key: string, params?: Record<string, string | number>): string {
    const value = en[key as keyof typeof en] ?? key
    return params ? value.replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`)) : value
}

function Fixture() {
    return (
        <main className="mx-auto max-w-[375px] space-y-4 px-3 py-4" data-testid="monitor-status-fixture">
            <header>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">Mobile visual fixture</p>
                <h1 className="mt-1 text-lg font-semibold text-[var(--app-fg)]">Seven-day status bars</h1>
            </header>
            <section aria-labelledby="fixture-http-title" className="space-y-2">
                <h2 id="fixture-http-title" className="text-sm font-semibold text-[var(--app-fg)]">HTTP probe</h2>
                <MonitorStatusTimeline monitor={httpMonitor} locale="en-US" t={t} />
            </section>
            <section aria-labelledby="fixture-webhook-title" className="space-y-2">
                <h2 id="fixture-webhook-title" className="text-sm font-semibold text-[var(--app-fg)]">Passive webhook</h2>
                <MonitorStatusTimeline monitor={webhookMonitor} locale="en-US" t={t} />
            </section>
        </main>
    )
}

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <Fixture />
        </React.StrictMode>
    )
}
