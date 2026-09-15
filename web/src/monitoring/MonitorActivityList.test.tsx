import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { MonitorActivityList } from './MonitorActivityList'

afterEach(cleanup)

describe('MonitorActivityList', () => {
    it('offers manual triggering only for deferred activity', () => {
        const onRetrigger = vi.fn()
        const activities = [
            { id: 'deferred', monitorId: 'm', createdAt: 2, source: 'webhook' as const, outcome: 'deferred' as const, summary: 'Waiting event', details: '{"data":1}' },
            { id: 'done', monitorId: 'm', createdAt: 1, source: 'webhook' as const, outcome: 'dispatched' as const, summary: 'Started event', details: '' }
        ]
        render(
            <I18nProvider>
                <MonitorActivityList activities={activities} locale="en-US" t={(key) => key} onRetrigger={onRetrigger} />
            </I18nProvider>
        )
        expect(screen.getAllByRole('button', { name: 'monitors.activity.retrigger' })).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', { name: 'monitors.activity.retrigger' }))
        expect(onRetrigger).toHaveBeenCalledWith(activities[0])
    })
})
