import { describe, expect, it } from 'vitest'
import { formatShareTimelineTime, groupShareTimeline } from './shareTimeline'

const labels = {
    today: 'Today',
    yesterday: 'Yesterday',
    daysAgo: (days: number) => `${days} days ago`
}

describe('groupShareTimeline', () => {
    it('sorts descending and uses local calendar-day boundaries across month and year rollover', () => {
        const now = new Date(2025, 0, 7, 12, 0, 0)
        const shares = [
            { id: 'seven-days', createdAt: new Date(2024, 11, 31, 23, 59, 59).getTime() },
            { id: 'six-days', createdAt: new Date(2025, 0, 1, 0, 0, 0).getTime() },
            { id: 'two-days', createdAt: new Date(2025, 0, 5, 11, 0, 0).getTime() },
            { id: 'yesterday', createdAt: new Date(2025, 0, 6, 23, 0, 0).getTime() },
            { id: 'today-early', createdAt: new Date(2025, 0, 7, 1, 0, 0).getTime() },
            { id: 'today-late', createdAt: new Date(2025, 0, 7, 11, 0, 0).getTime() }
        ]

        const groups = groupShareTimeline(shares, now, 'en-US', labels)

        expect(groups.map((group) => group.label)).toEqual([
            'Today',
            'Yesterday',
            '2 days ago',
            '6 days ago',
            new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(2024, 11, 31))
        ])
        expect(groups[0]?.shares.map((share) => share.id)).toEqual(['today-late', 'today-early'])
    })
})

describe('formatShareTimelineTime', () => {
    it('uses h23 HH:mm:ss formatting', () => {
        expect(formatShareTimelineTime(new Date(2025, 0, 7, 5, 4, 3).getTime(), 'en-US')).toBe('05:04:03')
    })
})
