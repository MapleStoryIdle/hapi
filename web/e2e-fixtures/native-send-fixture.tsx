import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError, type ApiClient } from '../src/api/client'
import { CodexSessionContextPage } from '../src/components/CodexSessionContextPage'
import { NativeSendStatusMessage, type NativeSendConnectionPhase } from '../src/components/NativeSendStatusMessage'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { I18nProvider } from '../src/lib/i18n-context'

let acceptedClientMessageId: string | undefined
const api = {
    getCodexSessionSnapshot: async () => ({
        success: true, session: { id: 'fixture', cwd: '/workspace/shapi', title: 'Native send check', modifiedAt: Date.now(), model: 'gpt-5.6', modelReasoningEffort: 'high' },
        messages: [{ id: 'original', createdAt: 1, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Ready for your next message.' } } } }],
        page: { limit: 50, hasMore: false, nextBefore: null }, version: { runnerEpoch: 'fixture', revision: 1 }, revision: 1,
        status: { success: true, status: 'idle', queuedMessages: [],
            ...(acceptedClientMessageId ? { deliveryReceipts: [{ id: acceptedClientMessageId, state: 'accepted' }] } : {})
        }, timing: { cache: 'hit', durationMs: 0 }
    }),
    getCodexSessionComposerCapabilities: async () => ({ success: true, skills: [], commands: [] }),
    getMachineCodexSubscriptionLimits: async () => ({ success: true, limits: null }),
    sendCodexSessionMessage: async (_sessionId: string, payload: { clientMessageId: string }) => {
        if (new URLSearchParams(location.search).has('ack')) acceptedClientMessageId = payload.clientMessageId
        throw new ApiError('timeout', 408, 'request_timeout')
    }
} as unknown as ApiClient

const emptyBlocks = [] as const
function ManagedComposer(props: { native?: boolean }) {
    const [state, setState] = useState<'thinking' | 'waiting' | 'idle'>('thinking')
    const runtime = useHappyRuntime({ session: { active: true, thinking: state !== 'idle' }, blocks: emptyBlocks,
        isSending: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <div data-testid="managed-composer">
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyComposer active thinking={state !== 'idle'} showStatusBar={false} agentFlavor={props.native ? null : 'codex'}
                readOnlyModelInfo={props.native} model={props.native ? 'gpt-5.6' : undefined}
                modelReasoningEffort={props.native ? 'high' : undefined}
                agentState={state === 'waiting' ? { requests: { q: { tool: 'AskUserQuestion', arguments: {}, createdAt: null } } } : null} />
        </AssistantRuntimeProvider>
        <button className="min-h-11 px-2" onClick={() => setState('waiting')}>HAPI: wait</button>
        <button className="min-h-11 px-2" onClick={() => setState('idle')}>HAPI: idle</button>
        <button className="min-h-11 px-2" onClick={() => setState('thinking')}>HAPI: run</button>
    </div>
}

function Demo() {
    const [phase, setPhase] = useState<NativeSendConnectionPhase | null>('launching')
    const [startedAt] = useState(Date.now())
    if (new URLSearchParams(location.search).has('page')) {
        return <CodexSessionContextPage api={api} sessionId="fixture" machineId="fixture-machine" onBack={() => {}} onForked={() => {}} />
    }
    return <main className="mx-auto max-w-lg space-y-8 p-5">
        <h1 className="text-lg font-semibold">SHAPI · Thinking</h1>
        <section className="space-y-3"><h2>Native</h2><NativeSendStatusMessage phase={phase} label={phase === 'launching' ? 'Starting connection' : 'Matching Agent'} startedAt={startedAt} waitingForOutput={phase === 'connected'} waitingStartedAt={startedAt} /></section>
        <section className="space-y-3"><h2>HAPI</h2><ManagedComposer native={new URLSearchParams(location.search).has('nativeComposer')} /></section>
        <nav className="flex flex-wrap gap-3">{(['launching', 'matching', 'connected', null] as const).map((value) => <button className="min-h-11 rounded-xl border px-3" key={value ?? 'reply'} onClick={() => setPhase(value)}>{value ?? 'Reply received'}</button>)}</nav>
    </main>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><I18nProvider><Demo /></I18nProvider></QueryClientProvider>)
