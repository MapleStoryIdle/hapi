import React from 'react'
import ReactDOM from 'react-dom/client'
import { CodexSubscriptionLimitsBadge } from '../src/components/SessionHeader'
import { I18nProvider } from '../src/lib/i18n-context'
import '../src/index.css'

const api = new URLSearchParams(location.search).has('api')
ReactDOM.createRoot(document.getElementById('root')!).render(<I18nProvider>
    <main className="min-h-screen bg-[var(--app-bg)] p-6"><div className="flex justify-end">
        <CodexSubscriptionLimitsBadge isFetching={false} error={null} onRefresh={() => {}}
            account={api ? { mode: 'api', label: 'localhost:8317', plan: null, source: 'currentConnection' } : { mode: 'oauth', label: 'd***@example.com', plan: '20x Pro', source: 'currentConnection' }}
            usage={{ input: 100000, output: 28400, cachedInput: 80000, reasoningOutput: 12000, total: 128400, scope: 'session', updatedAt: Date.now() }}
            limits={api ? null : { limitId: null, limitName: null, planType: 'pro', primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1789048800 }, secondary: { usedPercent: 57, windowDurationMins: 10080, resetsAt: 1789106400 }, updatedAt: Date.now() }} />
    </div></main>
</I18nProvider>)
