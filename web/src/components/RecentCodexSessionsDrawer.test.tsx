import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { RecentCodexSessionsDrawer } from './RecentCodexSessionsDrawer'

afterEach(() => cleanup())

function createApi(): ApiClient {
    return {
        getCodexSessions: vi.fn(async () => ({
            success: true as const,
            sessions: [{
                id: 'codex-thread-1',
                title: 'Recent Codex task',
                lastUserMessage: 'Original prompt',
                cwd: '/workspace/project',
                file: '/tmp/rollout.jsonl',
                modifiedAt: Date.now()
            }]
        })),
        getMachineGitBranch: vi.fn(async () => ({
            success: true as const,
            stdout: '# branch.head main\n',
            stderr: '',
            exitCode: 0
        }))
    } as unknown as ApiClient
}

describe('RecentCodexSessionsDrawer', () => {
    it('opens as a compact left drawer and closes through its header control', async () => {
        const onOpenChange = vi.fn()
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } }
        })
        render(
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <RecentCodexSessionsDrawer
                        api={createApi()}
                        machineId="machine-1"
                        open
                        onOpenChange={onOpenChange}
                        onOpenSession={vi.fn()}
                    />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(await screen.findByText('Recent Codex task')).toBeInTheDocument()
        expect(screen.getByRole('dialog')).toHaveClass('left-0')
        expect(screen.getByRole('dialog')).toHaveClass('w-[min(24rem,80vw)]')
        expect(screen.getByText('Recent Codex task')).toHaveClass('text-sm')

        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!)
        expect(onOpenChange).toHaveBeenCalledWith(false)
    })
})
