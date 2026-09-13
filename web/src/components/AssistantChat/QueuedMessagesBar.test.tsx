import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { DecryptedMessage } from '@/types/api'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import {
    computeCanCancel,
    computeEditPendingSchedule,
    getQueuedMessagePreview,
    getQueuedMessageSummary,
    QueuedMessagesBar,
    sortQueuedMessages,
} from './QueuedMessagesBar'
import { formatScheduledTime } from '@/lib/scheduledTime'

const mocks = vi.hoisted(() => ({
    addToast: vi.fn(),
    cancel: vi.fn(),
    cancelAsync: vi.fn(),
    composerState: { text: '', attachments: [] as unknown[] },
    setText: vi.fn(),
}))

vi.mock('@assistant-ui/react', () => ({
    useAssistantApi: () => ({
        composer: () => ({
            getState: () => mocks.composerState,
            setText: mocks.setText,
        }),
    }),
}))

vi.mock('@/hooks/mutations/useCancelQueuedMessage', () => ({
    useCancelQueuedMessage: () => ({
        isPending: false,
        variables: undefined,
        mutate: mocks.cancel,
        mutateAsync: mocks.cancelAsync,
    }),
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: mocks.addToast }),
}))

afterEach(() => {
    cleanup()
    mocks.addToast.mockReset()
    mocks.cancel.mockReset()
    mocks.cancelAsync.mockReset()
    mocks.setText.mockReset()
    mocks.composerState = { text: '', attachments: [] }
})

function makeQueuedMessage(
    id: string,
    createdAt: number,
    scheduledAt: number | null = null,
    text = id,
    attachmentNames: string[] = [],
): DecryptedMessage {
    const attachments = attachmentNames.map((filename, index) => ({
        id: `attachment-${index}`,
        filename,
        mimeType: 'text/plain',
        size: 1,
        path: `/tmp/${filename}`,
    }))
    return {
        id,
        localId: `local-${id}`,
        createdAt,
        seq: createdAt,
        scheduledAt,
        invokedAt: null,
        status: 'queued',
        content: {
            role: 'user',
            content: {
                type: 'text',
                text,
                ...(attachments.length > 0 ? { attachments } : {}),
            },
        },
    } as unknown as DecryptedMessage
}

function renderQueue(
    queuedMessages: readonly DecryptedMessage[],
    options: {
        onEdit?: (params: { id: string; text: string; pendingSchedule: PendingSchedule | null }) => void
        isEditScopeActive?: () => boolean
    } = {}
) {
    return render(
        <I18nProvider>
            <QueuedMessagesBar
                sessionId="session-1"
                api={null}
                queuedMessages={queuedMessages}
                {...options}
            />
        </I18nProvider>
    )
}

function openQueueDrawer() {
    fireEvent.click(screen.getByTestId('queued-messages-trigger'))
    return screen.getByTestId('queued-messages-drawer')
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

it('humanizes question reply XML before queue display and composer recovery', () => {
    const xml = '<send_user_message_question_reply>[{"questionItemId":"q","question":"Continue?","answer":"Yes"}]</send_user_message_question_reply>'
    expect(getQueuedMessagePreview(makeQueuedMessage('question', 1, null, xml)).text).toBe('Continue?\n• Yes')
})

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
        expect(trigger).toHaveClass('h-11')
        expect(trigger).not.toHaveClass('w-full')
        expect(trigger).toHaveTextContent('Queued')
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

describe('QueuedMessagesBar edit recovery', () => {
    it('hands off text and schedule after the last optimistic row unmounts the bar', async () => {
        const scheduledAt = Date.now() + 60_000
        const message = makeQueuedMessage('scheduled-edit', 1, scheduledAt, 'Keep this scheduled prompt')
        const onEdit = vi.fn()
        const deferred = createDeferred<{ status: 'cancelled'; localId: string | null }>()
        mocks.cancelAsync.mockReturnValue(deferred.promise)

        const view = renderQueue([message], { onEdit })
        openQueueDrawer()
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

        expect(mocks.cancelAsync).toHaveBeenCalledWith({
            sessionId: 'session-1',
            messageId: message.id,
            localId: message.localId,
            snapshot: message,
        })

        // This mirrors the optimistic removal of the final queued row: the
        // component goes away before React Query's request has settled.
        view.rerender(<I18nProvider>{null}</I18nProvider>)
        expect(screen.queryByTestId('queued-messages-trigger')).not.toBeInTheDocument()

        await act(async () => {
            deferred.resolve({ status: 'cancelled', localId: message.localId })
            await deferred.promise
        })

        expect(onEdit).toHaveBeenCalledWith({
            id: message.localId,
            text: 'Keep this scheduled prompt',
            pendingSchedule: { type: 'absolute', ms: scheduledAt },
        })
        expect(mocks.setText).not.toHaveBeenCalled()
    })

    it('never restores an edit when cancellation loses the invocation race', async () => {
        const message = makeQueuedMessage('already-invoked', 1, null, 'Too late to edit')
        const onEdit = vi.fn()
        mocks.cancelAsync.mockResolvedValue({ status: 'invoked', message })

        renderQueue([message], { onEdit })
        openQueueDrawer()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
            await Promise.resolve()
        })

        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.setText).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
            title: "Message already sent — it can't be edited",
            kind: 'warning',
        }))
    })

    it('never restores an edit when cancellation fails', async () => {
        const message = makeQueuedMessage('failed-edit', 1, null, 'Keep the queue row')
        const onEdit = vi.fn()
        mocks.cancelAsync.mockRejectedValue(new Error('network down'))

        renderQueue([message], { onEdit })
        openQueueDrawer()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
            await Promise.resolve()
        })

        expect(onEdit).not.toHaveBeenCalled()
        expect(mocks.setText).not.toHaveBeenCalled()
    })

    it('leaves a pre-existing composer draft untouched before cancelling', () => {
        const message = makeQueuedMessage('draft-exists', 1, null, 'Queued edit')
        mocks.composerState = { text: 'A newer draft', attachments: [] }

        renderQueue([message])
        openQueueDrawer()
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }))

        expect(mocks.cancelAsync).not.toHaveBeenCalled()
        expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Finish or clear your draft before editing a queued message.',
            kind: 'warning',
        }))
    })

    it('keeps the durable handoff when a newer draft starts during cancellation', async () => {
        const message = makeQueuedMessage('draft-during-cancel', 1, null, 'Queued edit')
        const onEdit = vi.fn()
        const deferred = createDeferred<{ status: 'cancelled'; localId: string | null }>()
        mocks.cancelAsync.mockReturnValue(deferred.promise)

        renderQueue([message], { onEdit })
        openQueueDrawer()
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
        mocks.composerState = { text: 'A newer draft', attachments: [] }

        await act(async () => {
            deferred.resolve({ status: 'cancelled', localId: message.localId })
            await deferred.promise
        })

        expect(onEdit).toHaveBeenCalledWith({
            id: message.localId,
            text: 'Queued edit',
            pendingSchedule: null,
        })
        expect(mocks.setText).not.toHaveBeenCalled()
    })

    it('uses the standalone composer fallback while its edit scope is active', async () => {
        const message = makeQueuedMessage('standalone-edit', 1, null, 'Restore this text')
        mocks.cancelAsync.mockResolvedValue({ status: 'cancelled', localId: message.localId })

        renderQueue([message], { isEditScopeActive: () => true })
        openQueueDrawer()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
            await Promise.resolve()
        })

        expect(mocks.setText).toHaveBeenCalledWith('Restore this text')
    })

    it('does not use the standalone composer fallback outside its edit scope', async () => {
        const message = makeQueuedMessage('scope-gone', 1, null, 'Do not restore here')
        mocks.cancelAsync.mockResolvedValue({ status: 'cancelled', localId: message.localId })

        renderQueue([message], { isEditScopeActive: () => false })
        openQueueDrawer()

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
            await Promise.resolve()
        })

        expect(mocks.setText).not.toHaveBeenCalled()
    })

    it('disables edit for attachment-bearing rows without cancelling them', () => {
        const message = makeQueuedMessage('attachment-edit', 1, null, 'Analyze this file', ['trace.log'])

        renderQueue([message])
        openQueueDrawer()

        const editButton = screen.getByRole('button', { name: 'Edit' })
        expect(editButton).toBeDisabled()
        expect(screen.getByTitle('Messages with attachments can’t be edited yet.')).toContainElement(editButton)
        fireEvent.click(editButton)
        expect(mocks.cancelAsync).not.toHaveBeenCalled()
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
