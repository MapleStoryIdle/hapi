import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { MOBILE_LAYOUT_CONTRACT } from '@/lib/mobileLayoutContract'
import { ToastProvider } from '@/lib/toast-context'
import type { Session } from '@/types/api'
import { getSessionCurrentBranch, SessionHeader } from './SessionHeader'

afterEach(() => cleanup())

function createSession(): Session {
    return {
        id: 'mobile-layout-contract-session',
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: {
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
        serviceTier: null,
        remoteServerId: null
    }
}

describe('getSessionCurrentBranch', () => {
    it('prefers the freshly reported Git branch over worktree metadata', () => {
        expect(getSessionCurrentBranch('main', 'feature/worktree')).toBe('main')
    })

    it('uses the worktree branch when a Git query is unavailable', () => {
        expect(getSessionCurrentBranch(null, 'feature/worktree')).toBe('feature/worktree')
    })

    it('does not render a branch for non-Git sessions', () => {
        expect(getSessionCurrentBranch('  ', undefined)).toBeNull()
    })
})

describe('mobile layout contract', () => {
    it('keeps the full-width floating header transparent and without blur', () => {
        const queryClient = new QueryClient({
            defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false }
            }
        })

        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={createSession()}
                            api={null}
                            onBack={() => {}}
                            floating
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const shell = screen.getByTestId(MOBILE_LAYOUT_CONTRACT.header.testId)
        expect(shell).toHaveAttribute('data-mobile-layout-contract', MOBILE_LAYOUT_CONTRACT.header.state)
        expect(shell.style.backgroundColor).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backgroundVariable})`)
        expect(shell.style.backdropFilter).toBe(`var(${MOBILE_LAYOUT_CONTRACT.header.backdropFilterVariable})`)
    })
})
