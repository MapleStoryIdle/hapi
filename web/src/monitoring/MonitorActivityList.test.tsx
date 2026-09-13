import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonitorActivityList } from './MonitorActivityList'

afterEach(cleanup)

describe('MonitorActivityList', () => {
    it('offers manual triggering only for deferred activity', () => {
        const onRetrigger = vi.fn()
        const activities = [
            { id: 'deferred', monitorId: 'm', createdAt: 2, source: 'webhook' as const, outcome: 'deferred' as const, summary: 'Waiting event', details: '{"data":1}' },
            { id: 'done', monitorId: 'm', createdAt: 1, source: 'webhook' as const, outcome: 'dispatched' as const, summary: 'Started event', details: '' }
        ]
        render(<MonitorActivityList activities={activities} locale="en-US" t={(key) => key} onRetrigger={onRetrigger} />)
        expect(screen.getAllByRole('button')).toHaveLength(1)
        fireEvent.click(screen.getByRole('button', { name: 'monitors.activity.retrigger' }))
        expect(onRetrigger).toHaveBeenCalledWith(activities[0])
    })
})
