import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError, type ApiClient } from '../src/api/client'
import { CodexSessionContextPage } from '../src/components/CodexSessionContextPage'
import { NativeSendStatusMessage, type NativeSendConnectionPhase } from '../src/components/NativeSendStatusMessage'
import { StatusBar } from '../src/components/AssistantChat/StatusBar'
import { I18nProvider } from '../src/lib/i18n-context'

const api = {
    getCodexSessionSnapshot: async () => ({
        success: true, session: { id: 'fixture', cwd: '/workspace/shapi', title: 'Native send check', modifiedAt: Date.now(), model: 'gpt-5.6', modelReasoningEffort: 'high' },
        messages: [{ id: 'original', createdAt: 1, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Ready for your next message.' } } } }],
        page: { limit: 50, hasMore: false, nextBefore: null }, version: { runnerEpoch: 'fixture', revision: 1 }, revision: 1,
        status: { success: true, status: 'idle', queuedMessages: [] }, timing: { cache: 'hit', durationMs: 0 }
    }),
    getCodexSessionComposerCapabilities: async () => ({ success: true, skills: [], commands: [] }),
    getMachineCodexSubscriptionLimits: async () => ({ success: true, limits: null }),
    sendCodexSessionMessage: async () => { throw new ApiError('timeout', 408, 'request_timeout') }
} as unknown as ApiClient

function Demo() {
    const [phase, setPhase] = useState<NativeSendConnectionPhase | null>('launching')
    const [startedAt] = useState(Date.now())
    if (new URLSearchParams(location.search).has('page')) {
        return <CodexSessionContextPage api={api} sessionId="fixture" machineId="fixture-machine" onBack={() => {}} onForked={() => {}} />
    }
    return <main className="mx-auto max-w-lg space-y-8 p-5">
        <h1 className="text-lg font-semibold">SHAPI · Thinking</h1>
        <section className="space-y-3"><h2>Native</h2><NativeSendStatusMessage phase={phase} label={phase === 'launching' ? 'Starting connection' : 'Matching Agent'} startedAt={startedAt} waitingForOutput={phase === 'connected'} waitingStartedAt={startedAt} /></section>
        <section className="space-y-3"><h2>HAPI</h2><StatusBar active thinking agentState={null} agentFlavor="codex" modelReasoningEffort="high" /></section>
        <nav className="flex flex-wrap gap-3">{(['launching', 'matching', 'connected', null] as const).map((value) => <button className="min-h-11 rounded-xl border px-3" key={value ?? 'reply'} onClick={() => setPhase(value)}>{value ?? 'Reply received'}</button>)}</nav>
    </main>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><Demo /></I18nProvider></QueryClientProvider>)
