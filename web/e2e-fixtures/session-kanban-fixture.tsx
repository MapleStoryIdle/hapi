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
        sessions: ['zeta', 'alpha'].map((directory) => ({
            id: directory,
            title: `${directory} task`,
            cwd: `/workspace/${directory}`,
            file: '',
            modifiedAt: now,
            runState: 'processing'
        }))
    }),
    getMachineGitBranch: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 })
} as unknown as ApiClient

ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
            <main className="mx-auto max-w-lg p-4">
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
