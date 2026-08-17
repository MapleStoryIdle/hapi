import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { DecryptedMessage } from '@/types/api'
import {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessageEditText,
    getQueuedMessagePreview,
    getQueuedMessageSummary,
    QueuedMessagesBar,
    sortQueuedMessages,
} from './QueuedMessagesBar'
import { formatScheduledTime } from '@/lib/scheduledTime'

const mocks = vi.hoisted(() => ({
    addToast: vi.fn(),
    cancel: vi.fn(),
    setText: vi.fn(),
}))

vi.mock('@assistant-ui/react', () => ({
    useAssistantApi: () => ({
        composer: () => ({ setText: mocks.setText }),
    }),
}))

vi.mock('@/hooks/mutations/useCancelQueuedMessage', () => ({
    useCancelQueuedMessage: () => ({
        isPending: false,
        variables: undefined,
        mutate: mocks.cancel,
    }),
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast }),
}))

afterEach(() => {
    cleanup()
    mocks.addToast.mockReset()
    mocks.cancel.mockReset()
    mocks.setText.mockReset()
})

function makeQueuedMessage(
    id: string,
    createdAt: number,
    scheduledAt: number | null = null,
    text = id,
): DecryptedMessage {
    return {
        id,
        localId: `local-${id}`,
        createdAt,
        seq: createdAt,
        scheduledAt,
        invokedAt: null,
        status: 'queued',
        content: { role: 'user', content: { type: 'text', text } },
    } as unknown as DecryptedMessage
}

/**
 * Unit tests for computeCanCancel — the race guard that prevents sending
 * DELETE before the hub has a row to delete (pre-server-echo scenario).
 *
 * Key invariant: useSendMessage.onMutate creates an optimistic message with
 *   { id: localId, localId }
 * so id === localId until the server echo (message-received SSE) arrives and
 * message-window-store replaces the row with the server-assigned UUID id.
 * After that replace, id !== localId.
 *
 * canCancel = hasServerEcho && !isPending
 */
describe('computeCanCancel', () => {
    describe('hasServerEcho detection', () => {
        it('is false when id === localId (purely optimistic, no server echo)', () => {
            // useSendMessage.onMutate sets id = localId before POST /messages completes.
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: false })).toBe(false)
        })

        it('is true when id !== localId (server echo replaced id with server UUID)', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })

        it('is true when localId is undefined/null (server-only row, no local tracking)', () => {
            // Rows from server-loaded history have no localId — treat as already echoed.
            expect(computeCanCancel({ id: 'server-uuid-789', localId: undefined, isPending: false })).toBe(true)
            expect(computeCanCancel({ id: 'server-uuid-789', localId: null, isPending: false })).toBe(true)
        })
    })

    describe('isPending guard', () => {
        it('is false when a cancel mutation is already in-flight, even with server echo', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            expect(computeCanCancel({ id: serverId, localId, isPending: true })).toBe(false)
        })

        it('is false when purely optimistic AND isPending', () => {
            const localId = 'local-abc-123'
            expect(computeCanCancel({ id: localId, localId, isPending: true })).toBe(false)
        })
    })

    describe('combined conditions', () => {
        it('is true only when server echo received AND no in-flight cancel', () => {
            const localId = 'local-abc-123'
            const serverId = 'server-uuid-456'
            // The normal case: user can click ✕ or ✎
            expect(computeCanCancel({ id: serverId, localId, isPending: false })).toBe(true)
        })
    })
})

// ---------------------------------------------------------------------------
// #4 computeEditPendingSchedule — edit restores scheduledAt as absolute pending
// ---------------------------------------------------------------------------

describe('computeEditPendingSchedule', () => {
    it('returns null for immediate-queued message (no scheduledAt)', () => {
        const now = Date.now()
        expect(computeEditPendingSchedule(null, now)).toBeNull()
        expect(computeEditPendingSchedule(undefined, now)).toBeNull()
    })

    it('returns null for scheduledAt in the past (message matured)', () => {
        const now = Date.now()
        const past = now - 5000 // 5 seconds ago
        expect(computeEditPendingSchedule(past, now)).toBeNull()
    })

    it('returns absolute PendingSchedule for future scheduledAt', () => {
        const now = Date.now()
        const future = now + 60_000 // 1 minute from now
        const result = computeEditPendingSchedule(future, now)
        expect(result).not.toBeNull()
        expect(result?.type).toBe('absolute')
        if (result?.type === 'absolute') {
            expect(result.ms).toBe(future)
        }
    })
})

describe('sortQueuedMessages', () => {
    it('places immediate-queued messages before scheduled ones', () => {
        const a = makeQueuedMessage('a-immediate', 1000)
        const b = makeQueuedMessage('b-scheduled-soon', 500, Date.now() + 60_000)
        const result = sortQueuedMessages([b, a])
        expect(result.map((m) => m.id)).toEqual(['a-immediate', 'b-scheduled-soon'])
    })

    it('orders immediate-queued messages by createdAt ascending', () => {
        const older = makeQueuedMessage('older', 1000)
        const newer = makeQueuedMessage('newer', 2000)
        const result = sortQueuedMessages([newer, older])
        expect(result.map((m) => m.id)).toEqual(['older', 'newer'])
    })

    it('orders scheduled messages by scheduledAt ascending (soonest first)', () => {
        const later = makeQueuedMessage('fires-later', 1000, 10_000)
        const sooner = makeQueuedMessage('fires-sooner', 2000, 5_000)
        const result = sortQueuedMessages([later, sooner])
        expect(result.map((m) => m.id)).toEqual(['fires-sooner', 'fires-later'])
    })

    it('combined: immediate first, then scheduled in fire-time order', () => {
        const im1 = makeQueuedMessage('im1', 1000)
        const im2 = makeQueuedMessage('im2', 2000)
        const sched1 = makeQueuedMessage('sched-near', 500, 5_000)
        const sched2 = makeQueuedMessage('sched-far', 600, 10_000)
        const result = sortQueuedMessages([sched2, im2, sched1, im1])
        expect(result.map((m) => m.id)).toEqual(['im1', 'im2', 'sched-near', 'sched-far'])
    })
})

describe('getQueuedMessageSummary', () => {
    it('separates immediate and future-scheduled queue items', () => {
        const now = 10_000
        expect(getQueuedMessageSummary([
            makeQueuedMessage('immediate', 1),
            makeQueuedMessage('matured-schedule', 2, now - 1),
            makeQueuedMessage('future-schedule', 3, now + 1),
        ], now)).toEqual({
            immediateCount: 2,
            scheduledCount: 1,
        })
    })
})

describe('QueuedMessagesBar drawer', () => {
    it('opens the detailed queue drawer from the compact floating entry', () => {
        const queuedMessage = makeQueuedMessage('queue-1', 1, null, 'Review the deployment log')

        render(
            <I18nProvider>
                <QueuedMessagesBar
                    sessionId="session-1"
                    api={null}
                    queuedMessages={[queuedMessage]}
                />
            </I18nProvider>
        )

        const trigger = screen.getByTestId('queued-messages-trigger')
        expect(trigger).toHaveClass('w-full')
        expect(trigger).toHaveTextContent('Review the deployment log')
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByTestId('queued-messages-drawer')).not.toBeInTheDocument()

        fireEvent.click(trigger)

        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        const drawer = screen.getByTestId('queued-messages-drawer')
        expect(drawer).toBeInTheDocument()
        expect(within(drawer).getByText('Queued messages')).toBeInTheDocument()
        expect(within(drawer).getByText('Review the deployment log')).toBeInTheDocument()
    })
})

describe('getQueuedMessagePreview', () => {
    it('keeps attachment names with a text prompt', () => {
        const message = {
            id: 'queued-with-image',
            localId: 'queued-with-image',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Analyze this screenshot',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })
    })

    it('uses attachment names for attachment-only queued messages', () => {
        const message = {
            id: 'queued-image-only',
            localId: 'queued-image-only',
            createdAt: 1000,
            seq: null,
            invokedAt: null,
            status: 'queued',
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: '',
                    attachments: [{
                        id: 'att-1',
                        filename: 'image.png',
                        mimeType: 'image/png',
                        size: 1234,
                        path: '/tmp/image.png',
                    }],
                },
            },
        } as unknown as DecryptedMessage

        expect(getQueuedMessagePreview(message)).toEqual({
            text: '',
            attachmentNames: ['image.png'],
        })
    })
})

describe('getQueuedMessageEditText', () => {
    it('keeps the prompt text when queued message has both text and attachments', () => {
        expect(getQueuedMessageEditText({
            text: 'Analyze this screenshot',
            attachmentNames: ['image.png'],
        })).toBe('Analyze this screenshot')
    })

    it('falls back to attachment names for attachment-only queued messages', () => {
        expect(getQueuedMessageEditText({
            text: '',
            attachmentNames: ['image.png', 'trace.log'],
        })).toBe('image.png, trace.log')
    })
})

// ---------------------------------------------------------------------------
// formatScheduledTime — cross-year support (#8)
// ---------------------------------------------------------------------------

describe('formatScheduledTime', () => {
    it('omits year for a date in the current year', () => {
        const now = new Date()
        // Use a date 1 month ahead in the same year, guarding against Dec edge case
        const sameYearDate = new Date(now.getFullYear(), now.getMonth() + 1 < 12 ? now.getMonth() + 1 : 0, 15, 10, 30)
        if (sameYearDate.getFullYear() !== now.getFullYear()) {
            // Wrapped to next year — skip (edge case in late December)
            return
        }
        const result = formatScheduledTime(sameYearDate.getTime())
        // Year digits should not appear
        expect(result).not.toContain(String(now.getFullYear()))
    })

    it('includes year for a date in a different year', () => {
        const nextYear = new Date().getFullYear() + 1
        const crossYearDate = new Date(nextYear, 0, 15, 10, 30) // Jan 15 next year
        const result = formatScheduledTime(crossYearDate.getTime())
        expect(result).toContain(String(nextYear))
    })
})
