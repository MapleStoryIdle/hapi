import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { SessionHeader } from '../src/components/SessionHeader'
import { ToastProvider } from '../src/lib/toast-context'
import { I18nProvider } from '../src/lib/i18n-context'
import type { Session } from '../src/types/api'

const session: Session = {
    id: 'session-header-e2e',
    namespace: 'default',
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
    active: true,
    activeAt: 0,
    metadata: {
        name: 'Header test',
        path: '/workspace/hapi',
        host: 'localhost',
        flavor: 'claude'
    },
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    model: null,
    modelReasoningEffort: null,
    effort: null,
    serviceTier: null
}

function HeaderFixture() {
    const [backCount, setBackCount] = React.useState(0)
    const [threadTapCount, setThreadTapCount] = React.useState(0)
    const queryClient = React.useMemo(() => new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false }
        }
    }), [])

    return (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <I18nProvider>
                    <div className="relative h-full overflow-hidden bg-[var(--app-chat-canvas)]">
                        <button
                            type="button"
                            data-testid="session-header-thread-hit-target"
                            aria-label="Conversation thread"
                            className="absolute inset-0 z-0 h-full w-full bg-[var(--app-chat-canvas)] text-transparent"
                            onClick={() => setThreadTapCount((count) => count + 1)}
                        >
                            Conversation thread
                        </button>
                        <SessionHeader
                            session={session}
                            api={null}
                            onBack={() => setBackCount((count) => count + 1)}
                            floating
                        />
                        <output className="sr-only" data-testid="session-header-back-count">{backCount}</output>
                        <output className="sr-only" data-testid="session-header-thread-tap-count">{threadTapCount}</output>
                    </div>
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(<HeaderFixture />)
}
