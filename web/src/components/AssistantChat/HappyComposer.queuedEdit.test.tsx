import { useState } from 'react'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { clearDraft, saveDraft } from '@/lib/composer-drafts'
import { consumeQueuedMessageEdit, enqueueQueuedMessageEdit, getQueuedMessageEdit } from '@/lib/queued-message-edits'
import { HappyComposer, type ComposerSendError } from './HappyComposer'
import type { PendingSchedule } from './ScheduleTimePicker'

const sessionId = 'queued-edit-composer-test'
const emptyBlocks = [] as const
const skills = [{ name: 'review', description: 'Review code' }]
function Harness(props: { sendError?: ComposerSendError | null }) {
    const [schedule, setSchedule] = useState<PendingSchedule | null>(null)
    const runtime = useHappyRuntime({ session: { active: true, thinking: false }, blocks: emptyBlocks,
        isSending: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}>
        <HappyComposer sessionId={sessionId} active showStatusBar={false} skills={skills}
            sendError={props.sendError}
            pendingSchedule={schedule} onSchedule={setSchedule} onClearSchedule={() => setSchedule(null)} />
        <output data-testid="schedule">{JSON.stringify(schedule)}</output>
    </AssistantRuntimeProvider>
}
function mount() {
    const client = new QueryClient()
    const tree = (sendError: ComposerSendError | null = null) => <QueryClientProvider client={client}><I18nProvider><Harness sendError={sendError} /></I18nProvider></QueryClientProvider>
    const rendered = render(tree())
    return { ...rendered, setSendError: (error: ComposerSendError | null) => rendered.rerender(tree(error)) }
}
afterEach(() => {
    cleanup()
    clearDraft(sessionId)
    let pending = getQueuedMessageEdit(sessionId)
    while (pending) { consumeQueuedMessageEdit(sessionId, pending.id); pending = getQueuedMessageEdit(sessionId) }
    sessionStorage.clear()
})

describe('queue edit composer handoff', () => {
    it('lets failed-send restoration win without consuming the cancelled message edit', async () => {
        const mounted = mount()
        await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
        await act(async () => {
            enqueueQueuedMessageEdit(sessionId, { id: 'edit-a', text: 'Cancelled A', pendingSchedule: null })
            mounted.setSendError({ id: 1, text: 'Failed draft B', message: 'Rejected', scheduledAt: null })
        })
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Failed draft B'))
        expect(getQueuedMessageEdit(sessionId)?.text).toBe('Cancelled A')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
        mounted.setSendError(null)
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Cancelled A'))
        expect(getQueuedMessageEdit(sessionId)).toBeNull()
    })
    it('restores the full text, selected skill and future schedule after the queue row is gone', async () => {
        const ms = Date.now() + 60_000
        enqueueQueuedMessageEdit(sessionId, { id: 'cancelled', text: '$review check this change', pendingSchedule: { type: 'absolute', ms } })
        mount()
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('check this change'))
        expect(screen.getByLabelText('Cancel skill review')).toBeInTheDocument()
        expect(screen.getByTestId('schedule')).toHaveTextContent(String(ms))
        expect(getQueuedMessageEdit(sessionId)).toBeNull()
    })

    it('preserves an existing draft then restores the saved edit only after that draft is cleared', async () => {
        saveDraft(sessionId, 'My current draft')
        enqueueQueuedMessageEdit(sessionId, { id: 'waiting', text: 'Previously queued', pendingSchedule: null })
        mount()
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('My current draft'))
        expect(getQueuedMessageEdit(sessionId)?.id).toBe('waiting')
        fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
        await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Previously queued'))
        expect(getQueuedMessageEdit(sessionId)).toBeNull()
    })

    it('does not overwrite text typed while cancellation is in flight', async () => {
        mount()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New words' } })
        await act(async () => enqueueQueuedMessageEdit(sessionId, { id: 'late', text: 'Cancelled queue text', pendingSchedule: null }))
        expect(screen.getByRole('textbox')).toHaveValue('New words')
        expect(getQueuedMessageEdit(sessionId)?.text).toBe('Cancelled queue text')
    })
})
