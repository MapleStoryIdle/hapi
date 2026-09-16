import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Monitor } from '@hapi/protocol/monitoring'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionMonitorControl } from './SessionMonitorControl'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

afterEach(() => {
    cleanup()
    navigate.mockReset()
})

const monitor: Monitor = {
    id: 'monitor-1',
    config: {
        name: 'prod-error-hook',
        kind: 'webhook',
        machineId: 'machine-1',
        directory: '/work',
        agent: 'codex',
        model: '',
        reasoningEffort: '',
        permissionMode: 'default',
        prompt: 'Investigate',
        webhookIgnoreKeywords: '',
        deliveryMode: 'current-session',
        expiresAt: null,
        enabled: true,
        request: null
    },
    createdAt: 1,
    updatedAt: 1,
    health: 'unknown',
    lastCheckedAt: null,
    lastLatencyMs: null,
    lastError: null,
    nextCheckAt: 0,
    buckets: [],
    incident: null,
    lastActivity: {
        id: 'activity-1',
        monitorId: 'monitor-1',
        createdAt: 100,
        source: 'webhook',
        outcome: 'ok',
        summary: 'Trigger summary'
    },
    lastDelivery: {
        id: 'incident-1',
        monitorId: 'monitor-1',
        createdAt: 100,
        updatedAt: 200,
        deliveredAt: 200,
        state: 'closed',
        summary: 'Delivery summary'
    },
    callStats: { total: 1, ok: 1, failed: 0, dispatched: 0, deferred: 0, duplicate: 0, ignored: 0 }
}

it('opens on delivery, switches to trigger, and uses the monitor name as the details action', () => {
    render(<I18nProvider><SessionMonitorControl api={{} as ApiClient} monitors={[monitor]} refetch={async () => {}} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: '1 monitors are linked to this session' }))

    expect(screen.getByRole('tab', { name: 'Latest delivery' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Delivery summary')).toBeInTheDocument()
    expect(screen.queryByText('Trigger summary')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop monitor' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'View details' })).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Latest trigger' }))
    expect(screen.getByRole('tab', { name: 'Latest trigger' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Trigger summary')).toBeInTheDocument()
    expect(screen.queryByText('Delivery summary')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'prod-error-hook' }))
    expect(navigate).toHaveBeenCalledWith({ to: '/monitors/$monitorId', params: { monitorId: 'monitor-1' } })
})
