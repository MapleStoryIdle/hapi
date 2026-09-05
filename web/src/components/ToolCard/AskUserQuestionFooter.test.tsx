import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import { AskUserQuestionFooter } from './AskUserQuestionFooter'

vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: (props: { content: string }) => <>{props.content}</> }))
afterEach(cleanup)

function setup(multiSelect: boolean, cursor = false) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const tool: ChatToolCall = {
        id: 'tool-ask', name: cursor ? 'CursorAskQuestion' : 'AskUserQuestion', state: 'pending',
        input: { questions: [{ id: 'features', question: 'Which features?', multiSelect,
            options: [{ id: 'code', label: 'Code' }, { id: 'docs', label: 'Docs' }] }] },
        createdAt: 1, startedAt: null, completedAt: null, description: null,
        permission: { id: 'permission-ask', status: 'pending' }
    }
    render(<I18nProvider><AskUserQuestionFooter api={{ approvePermission } as unknown as ApiClient} tool={tool} sessionId="s1" disabled={false} onDone={() => {}} /></I18nProvider>)
    return approvePermission
}

describe('AskUserQuestionFooter', () => {
    it('single choice sends immediately with the existing index/label payload', () => {
        const approve = setup(false)
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('radio', { name: 'Code' }))
        expect(approve).toHaveBeenCalledWith('s1', 'permission-ask', { answers: { '0': ['Code'] } })
    })

    it('multi-select keeps Send, allows deselecting and sends the final choices only', async () => {
        const approve = setup(true)
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        fireEvent.click(screen.getByRole('checkbox', { name: 'Code' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Docs' }))
        fireEvent.click(screen.getByRole('checkbox', { name: 'Code' }))
        expect(approve).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(approve).toHaveBeenCalledWith('s1', 'permission-ask', { answers: { '0': ['Docs'] } }))
    })

    it('preserves Cursor stable question and option IDs', () => {
        const approve = setup(true, true)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Docs' }))
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        expect(approve).toHaveBeenCalledWith('s1', 'permission-ask', { answers: { features: ['docs'] } })
    })

    it('requires the Other text if Other is checked alongside multi-select options', () => {
        const approve = setup(true)
        fireEvent.click(screen.getByRole('checkbox', { name: 'Code' }))
        fireEvent.click(screen.getByRole('checkbox', { name: /Other/ }))
        expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tests too' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        expect(approve).toHaveBeenCalledWith('s1', 'permission-ask', { answers: { '0': ['Code', 'Tests too'] } })
    })
})
