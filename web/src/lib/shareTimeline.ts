export type ShareTimelineItem = {
    createdAt: number
}

export type ShareTimelineLabels = {
    today: string
    yesterday: string
    daysAgo: (days: number) => string
}

export type ShareTimelineGroup<T> = {
    key: string
    label: string
    shares: T[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function localDayIndex(date: Date): number {
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

export function localDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function timelineLabel(createdAt: Date, now: Date, locale: string, labels: ShareTimelineLabels): string {
    const daysAgo = localDayIndex(now) - localDayIndex(createdAt)
    if (daysAgo === 0) return labels.today
    if (daysAgo === 1) return labels.yesterday
    if (daysAgo >= 2 && daysAgo <= 6) return labels.daysAgo(daysAgo)
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(createdAt)
}

export function groupShareTimeline<T extends ShareTimelineItem>(
    shares: readonly T[],
    now: Date,
    locale: string,
    labels: ShareTimelineLabels
): ShareTimelineGroup<T>[] {
    const groups = new Map<string, ShareTimelineGroup<T>>()
    const sorted = shares
        .map((share, index) => ({ share, index }))
        .sort((left, right) => right.share.createdAt - left.share.createdAt || left.index - right.index)

    for (const { share } of sorted) {
        const createdAt = new Date(share.createdAt)
        const key = localDateKey(createdAt)
        const existing = groups.get(key)
        if (existing) {
            existing.shares.push(share)
            continue
        }
        groups.set(key, {
            key,
            label: timelineLabel(createdAt, now, locale, labels),
            shares: [share]
        })
    }
    return [...groups.values()]
}

export function formatShareTimelineTime(createdAt: number, locale: string): string {
    if (!Number.isFinite(createdAt)) return '—'
    return new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).format(new Date(createdAt))
}
