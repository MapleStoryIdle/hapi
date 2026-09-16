import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CodexUsageDrawer, formatCodexAccountExpiry, formatCodexPlan } from './CodexUsageDrawer'
import { I18nProvider } from '@/lib/i18n-context'
import type { ComponentProps, ReactNode } from 'react'

vi.mock('./ui/BottomDrawer', () => ({ BottomDrawer: ({ children, open, title }: { children: ReactNode; open: boolean; title: string }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }))
afterEach(cleanup)
function mount(overrides: Partial<ComponentProps<typeof CodexUsageDrawer>> = {}) {
    localStorage.setItem('hapi-lang', 'en')
    return render(<I18nProvider><CodexUsageDrawer open onOpenChange={() => {}} rows={[]} updatedAt={null} isFetching={false} error={null} {...overrides} /></I18nProvider>)
}
describe('iOS Codex usage drawer', () => {
    it('places quota below the account and hides connection/reset descriptions', () => {
        mount({ account: { mode: 'oauth', label: 'demo@example.com', plan: 'pro', expiresAt: null, source: 'currentConnection' },
            rows: [{ label: '5h', remaining: 50, resetAt: null }],
            usage: { input: 100, output: 20, cachedInput: 50, reasoningOutput: null, total: 120, scope: 'partial', updatedAt: 1 } })
        const sections = Array.from(screen.getByTestId('codex-usage-details').querySelectorAll('section'))
        expect(sections[0]).toHaveTextContent('demo@example.com')
        expect(screen.getByTestId('codex-usage-account-email-row')).toHaveTextContent('demo@example.com')
        expect(screen.getByTestId('codex-usage-account-plan-row')).toHaveTextContent('Pro · Authorized login')
        expect(screen.getByTestId('codex-usage-account-email-row').firstElementChild).toHaveClass('h-7', 'w-7')
        expect(screen.getByTestId('codex-usage-account-plan-row').firstElementChild).toHaveClass('h-7', 'w-7')
        expect(sections[0]).not.toHaveTextContent('Expires')
        expect(sections[1]).toHaveTextContent('This sessionTotal tokens70')
        expect(sections[2]).toHaveTextContent('Remaining quota')
        expect(screen.queryByTestId('codex-usage-breakdown')).toBeNull()
        expect(screen.queryByText(/current connection/i)).toBeNull()
        expect(screen.queryByText(/counter restarted/i)).toBeNull()
    })
    it('shows raw input, cached input, output, reasoning output, and model-effort breakdown', () => {
        const expiresAt = Date.parse('2026-10-01T00:00:00.000Z')
        mount({ account: { mode: 'oauth', label: 'demo@example.com', plan: '20x Pro', expiresAt, source: 'currentConnection' }, usage: {
            input: 1000,
            output: 200,
            cachedInput: 800,
            total: 1200,
            reasoningOutput: 100,
            breakdown: [{ input: 1000, output: 200, cachedInput: 800, total: 1200, reasoningOutput: 100, model: 'gpt-5.6', reasoningEffort: 'high' }],
            scope: 'session',
            updatedAt: 1
        } })
        expect(screen.getByRole('dialog', { name: 'Usage' })).toBeInTheDocument()
        expect(screen.getByTestId('codex-usage-account-plan-row')).toHaveTextContent(`20x Pro · Authorized login · Expires · ${formatCodexAccountExpiry(expiresAt, 'en')}`)
        expect(screen.getByText('Total tokens').nextElementSibling).toHaveTextContent('400')
        expect(screen.getByTestId('codex-usage-input-metric')).toHaveTextContent('Input200')
        expect(screen.getByTestId('codex-usage-cached-input-metric')).toHaveTextContent('Cached input800')
        expect(screen.getByTestId('codex-usage-cached-input-metric')).not.toHaveTextContent('80%')
        expect(screen.getByTestId('codex-usage-cache-ratio')).toHaveTextContent('Cache hit rate80%')
        expect(screen.getByTestId('codex-usage-cache-ratio')).toHaveClass('w-full')
        expect(screen.getByTestId('codex-usage-cached-input-metric')).not.toContainElement(screen.getByTestId('codex-usage-cache-ratio'))
        expect(screen.getByTestId('codex-usage-cache-ratio').querySelector('[style]')).toHaveStyle({ width: '80%' })
        expect(screen.getByTestId('codex-usage-reasoning-output-metric')).toHaveTextContent('Reasoning output100')
        expect(screen.getByTestId('codex-usage-breakdown')).toHaveTextContent('By model and reasoning effortgpt-5.6Reasoning effort: high400Input 200 · Cached 800 · Output 200 · Reasoning 100')
        expect(screen.getByLabelText('This session · parent and subagents')).toBeInTheDocument()
        expect(screen.getByTestId('codex-usage-total-metric')).toHaveTextContent('Total tokens400')
        expect(screen.getByTestId('codex-usage-input-metric')).toHaveClass('rounded-2xl', 'border', 'text-left')
        expect(screen.getByTestId('codex-usage-output-metric')).toHaveClass('rounded-2xl', 'border', 'text-left')
        expect(formatCodexPlan('pro')).toBe('Pro')
    })
    it('does not show subscription quota or plan for API connections', () => {
        mount({ account: { mode: 'api', label: 'localhost:8317', plan: 'pro', source: 'currentConnection' }, rows: [{ label: '5h', remaining: 50, resetAt: null }] })
        expect(screen.getByText('API access')).toBeInTheDocument()
        expect(screen.queryByText('Remaining quota')).toBeNull()
        expect(screen.queryByText('Pro')).toBeNull()
        expect(screen.getByText('No usage reported yet')).toBeInTheDocument()
    })
    it('shows missing cache as unknown rather than zero and offers refresh without raw errors', () => {
        const refresh = vi.fn()
        mount({ usage: { input: 0, output: null, cachedInput: null, reasoningOutput: null, total: null, scope: 'lastTurn', updatedAt: 0 }, error: 'secret-path/raw-error', onRefresh: refresh })
        expect(screen.getByText('Partial records · latest turn only')).toBeInTheDocument()
        expect(screen.getByTestId('codex-usage-cached-input-metric')).not.toHaveTextContent('%')
        expect(screen.queryByText('0%')).toBeNull()
        expect(screen.queryByText('secret-path/raw-error')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
        expect(refresh).toHaveBeenCalledTimes(1)
    })
})
