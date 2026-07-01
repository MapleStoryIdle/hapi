import type { SessionSummary } from '@/types/api'

export function pickMostRecentActiveSession(sessions: readonly SessionSummary[]): SessionSummary | null {
    let best: SessionSummary | null = null

    for (const session of sessions) {
        if (!session.active) continue

        if (!best) {
            best = session
            continue
        }

        // 中文注释：updatedAt 会随消息活动刷新，最贴近“最近沟通”的排序口径。
        if (session.updatedAt !== best.updatedAt) {
            best = session.updatedAt > best.updatedAt ? session : best
            continue
        }

        if (session.activeAt !== best.activeAt) {
            best = session.activeAt > best.activeAt ? session : best
            continue
        }

        if (session.id > best.id) {
            best = session
        }
    }

    return best
}
