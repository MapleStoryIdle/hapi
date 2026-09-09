import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { NativeCodexUserInput } from './NativeCodexUserInput'
import { NativeAsyncUserInput } from './NativeAsyncUserInput'

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: (props: { content: string }) => <>{props.content}</> }))
afterEach(() => { cleanup(); sessionStorage.clear() })

describe('native question recovery', () => {
    it('auto-opens once, preserves dismissal across remounts, and allows manual reopening', () => {
        const api = { sendCodexSessionMessage: vi.fn() } as unknown as ApiClient
        const show = () => <I18nProvider><NativeAsyncUserInput api={api} machineId="m" sessionId="s" input={{ callId: 'once', questions: [{ id: 'id', question: 'Continue?', options: ['Yes'] }] }} onRefresh={vi.fn()} /></I18nProvider>
        const view = render(show())
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        view.unmount()
        render(show())
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByTestId('native-question-summary')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(api.sendCodexSessionMessage).not.toHaveBeenCalled()
    })

    it('does not automatically open a historical pending question', () => {
        render(<I18nProvider><NativeAsyncUserInput api={{} as ApiClient} machineId="m" sessionId="s" autoOpen={false} input={{ callId: 'old', questions: [{ id: 'id', question: 'Old question', options: ['Yes'] }] }} onRefresh={vi.fn()} /></I18nProvider>)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Answer question' })).toBeInTheDocument()
    })

    it('closes a stale question when the server says another client already resolved it', async () => {
        const controlCodexSession = vi.fn().mockResolvedValue({ success: false, code: 'turn_changed' })
        const refresh = vi.fn()
        render(<I18nProvider><NativeCodexUserInput api={{ controlCodexSession } as unknown as ApiClient} machineId="m1" sessionId="s1" input={input} onRefresh={refresh} /></I18nProvider>)
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(refresh).toHaveBeenCalledTimes(1)
        expect(screen.queryByText(/Could not submit/)).not.toBeInTheDocument()
    })
    const input = { threadId: 's1', turnId: 't1', itemId: 'q1', questions: [{ id: 'choice', question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] }
    it('waits for an explicit choice and submits against the exact native turn', async () => {
        const controlCodexSession = vi.fn().mockResolvedValue({ success: true })
        const refresh = vi.fn()
        render(<I18nProvider><NativeCodexUserInput api={{ controlCodexSession } as unknown as ApiClient} machineId="m1" sessionId="s1" input={input} onRefresh={refresh} /></I18nProvider>)
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(controlCodexSession).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
        await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
        expect(controlCodexSession).toHaveBeenCalledWith('s1', 'm1', { action: 'answerUserInput', expectedTurnId: 't1', requestId: 'q1', answers: { choice: { answers: ['Yes'] } } })
    })
    it('retains a failed form instead of pretending the answer succeeded', async () => {
        const controlCodexSession = vi.fn().mockResolvedValue({ success: false })
        const refresh = vi.fn()
        render(<I18nProvider><NativeCodexUserInput api={{ controlCodexSession } as unknown as ApiClient} machineId="m1" sessionId="s1" input={input} onRefresh={refresh} /></I18nProvider>)
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
        await waitFor(() => expect(screen.getByText(/Could not submit/)).toBeInTheDocument())
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(refresh).not.toHaveBeenCalled()
    })
    it('closing only dismisses the drawer and allows reopening without answering', async () => {
        const controlCodexSession = vi.fn()
        render(<I18nProvider><NativeCodexUserInput api={{ controlCodexSession } as unknown as ApiClient} machineId="m1" sessionId="s1" input={input} onRefresh={vi.fn()} /></I18nProvider>)
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        fireEvent.click(screen.getByRole('button', { name: 'Close' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(controlCodexSession).not.toHaveBeenCalled()
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        expect(controlCodexSession).not.toHaveBeenCalled()
    })
    it('sends async answers as an idempotent user message, never a permission approval', async () => {
        const sendCodexSessionMessage = vi.fn().mockResolvedValue({ success: true, status: 'queued' })
        const api = { sendCodexSessionMessage } as unknown as ApiClient
        render(<I18nProvider><NativeAsyncUserInput api={api} machineId="m1" sessionId="s1" input={{ callId: 'call-1', questions: [{ id: '["request_user_input_async","call-1",0]', question: 'Continue?', options: ['Yes', 'No'] }] }} onRefresh={vi.fn()} /></I18nProvider>)
        expect(sendCodexSessionMessage).not.toHaveBeenCalled()
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        fireEvent.click(screen.getByRole('radio', { name: 'Yes' }))
        await waitFor(() => expect(screen.getByText('Answer saved for delivery')).toBeInTheDocument())
        expect(screen.getByText('Yes')).toBeInTheDocument()
        expect(sendCodexSessionMessage).toHaveBeenCalledWith('s1', expect.objectContaining({ machineId: 'm1', clientMessageId: 'native-answer:call-1', message: expect.stringContaining('send_user_message_question_reply') }))
    })
    it('replaces an open async drawer with the desktop answer and never reopens on remount', () => {
        const api = { sendCodexSessionMessage: vi.fn() } as unknown as ApiClient
        const question = { callId: 'q', questions: [{ id: 'id', question: 'Continue?', options: ['Yes'] }] }
        const show = (resolved: boolean) => <I18nProvider><NativeAsyncUserInput api={api} machineId="m" sessionId="s" input={{ ...question, resolved, answers: resolved ? { id: ['Yes'] } : {} }} onRefresh={vi.fn()} /></I18nProvider>
        const view = render(show(false))
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        expect(screen.getByRole('dialog')).toBeInTheDocument()
        view.rerender(show(true))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByText('Yes')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Answer question' })).not.toBeInTheDocument()
        view.unmount()
        render(show(true))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(api.sendCodexSessionMessage).not.toHaveBeenCalled()
    })
    it('closes a native drawer when the live request completes elsewhere', () => {
        const api = { controlCodexSession: vi.fn() } as unknown as ApiClient
        const show = (resolved: boolean) => <I18nProvider><NativeCodexUserInput api={api} machineId="m" sessionId="s" input={input} resolved={resolved} onRefresh={vi.fn()} /></I18nProvider>
        const view = render(show(false))
        if (!screen.queryByRole('dialog')) fireEvent.click(screen.getByRole('button', { name: 'Answer question' }))
        view.rerender(show(true))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(screen.getByText('Question completed')).toBeInTheDocument()
        expect(api.controlCodexSession).not.toHaveBeenCalled()
    })
})
