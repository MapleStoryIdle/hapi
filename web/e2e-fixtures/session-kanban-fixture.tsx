import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '../src/api/client'
import { RecentCodexSessions } from '../src/components/RecentCodexSessions'
import { I18nProvider } from '../src/lib/i18n-context'
import '../src/index.css'

const now = Date.now()
const api = {
    getCodexSessions: async () => ({
        success: true,
        sessions: [...['zeta', 'alpha'].map((directory) => ({
            id: directory,
            title: `${directory} task`,
            cwd: `/workspace/${directory}`,
            file: '',
            modifiedAt: now,
            runState: 'processing'
        })), ...[
            { id: 'recent', age: 60_000 },
            { id: 'today', age: 3_600_000 },
            { id: 'yesterday', age: 25 * 3_600_000 }
        ].map(({ id, age }) => ({
            id,
            title: `${id} task`,
            cwd: '/workspace/finished',
            file: '',
            modifiedAt: now - age,
            runState: 'idle'
        }))]
    }),
    getMachineGitBranch: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 })
} as unknown as ApiClient

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
            <main className="cupertino-session-index mx-auto max-w-lg p-4">
                <RecentCodexSessions
                    api={api}
                    machineId="fixture"
                    hapiSessions={[]}
                    embedded
                    hideHeader
                    viewMode="kanban"
                    onOpen={() => {}}
                />
            </main>
        </I18nProvider>
    </QueryClientProvider>
)
