import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '../src/api/client'
import { I18nProvider } from '../src/lib/i18n-context'
import { useTranslation } from '../src/lib/use-translation'
import { MonitorForm } from '../src/monitoring/MonitorForm'
import { NewSession } from '../src/components/NewSession'
import { useMachines } from '../src/hooks/queries/useMachines'
import { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } from '@tanstack/react-router'
import { AppContextProvider } from '../src/lib/app-context'
import { ToastProvider } from '../src/lib/toast-context'
import MonitorDetailPage from '../src/routes/monitor'
import { MonitorCard } from '../src/routes/monitors'
import type { Monitor } from '@hapi/protocol/monitoring'
import { createDefaultMonitorConfig } from '../src/monitoring/presentation'
import '../src/index.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const api = new ApiClient('fixture-not-a-real-token')

function Fixture() {
    const { t, locale } = useTranslation()
    const [saved, setSaved] = useState('')
    const [enabled, setEnabled] = useState(true)
    const { machines, isLoading } = useMachines(api, true)
    const bound = new URLSearchParams(window.location.search).has('bound')
    if (new URLSearchParams(window.location.search).has('card')) {
        const monitor: Monitor = { id: 'fixture', config: { ...createDefaultMonitorConfig(), kind: 'webhook', name: 'Production events', enabled }, health: 'unknown', createdAt: Date.now(), updatedAt: Date.now(), lastCheckedAt: null, lastLatencyMs: null, lastError: null, buckets: [], incident: null }
        return <main className="p-4"><MonitorCard monitor={monitor} busy={false} locale="en-US" t={t} onToggle={() => setEnabled(value => !value)} onDelete={() => setSaved('delete requested')} /><output>{saved}</output></main>
    }
    if (new URLSearchParams(window.location.search).has('newSession')) {
        return <main className="mx-auto max-w-lg p-4"><NewSession api={api} machines={machines} isLoading={isLoading} initialMachineId="fixture-machine" onSuccess={() => { throw new Error('Directory selection must not create a session') }} onCancel={() => {}} /></main>
    }
    return (
        <main className="mx-auto max-w-lg px-4 py-5">
            <style>{'html,body,#root{height:auto;min-height:100%;overflow:visible}'}</style>
            <h1 className="mb-4 text-xl font-semibold">{t('monitors.create.title')}</h1>
            <MonitorForm
                api={api} baseUrl="" t={t} locale={locale}
                initialConfig={{ ...createDefaultMonitorConfig(), name: 'Production API', machineId: 'fixture-machine', directory: '/workspace/api',
                    ...(bound ? { targetSession: { type: 'native-codex' as const, sessionId: 'fixture-session' } } : {}) }}
                lockedBinding={bound}
                submitLabel="Save fixture" savingLabel="Saving"
                onSubmit={async (config) => { setSaved(JSON.stringify(config)) }}
            />
            <output data-testid="saved-config" className="sr-only">{saved}</output>
        </main>
    )
}

const detail = new URLSearchParams(window.location.search).has('detail')
const rootRoute = createRootRoute({ component: () => detail ? <Outlet /> : <Fixture /> })
const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: '/monitors/$monitorId', component: MonitorDetailPage })
const router = createRouter({ routeTree: rootRoute.addChildren([detailRoute]), history: createMemoryHistory({ initialEntries: [detail ? '/monitors/fixture' : '/'] }) })
ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}><I18nProvider><AppContextProvider value={{ api, token: 'fixture-not-a-real-token', baseUrl: '' }}><ToastProvider><RouterProvider router={router} /></ToastProvider></AppContextProvider></I18nProvider></QueryClientProvider>
)
