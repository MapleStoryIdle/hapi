import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ReasoningGroup } from './reasoning'

const state = vi.hoisted(() => ({
    message: {
        content: [
            { type: 'reasoning', text: 'Checking the first operation' },
            { type: 'text', text: 'A progress update' },
            { type: 'reasoning', text: 'Verifying the second operation' },
            { type: 'reasoning', text: 'Checking its result' }
        ],
        status: { type: 'running' }
    }
}))

vi.mock('@assistant-ui/react', async (importOriginal) => ({
    ...await importOriginal<typeof import('@assistant-ui/react')>(),
    useMessage: () => state.message
}))

afterEach(cleanup)

describe('ReasoningGroup', () => {
    it('previews only its own content range, not every reasoning part in the message', () => {
        render(
            <I18nProvider>
                <ReasoningGroup startIndex={0} endIndex={0}>First details</ReasoningGroup>
                <ReasoningGroup startIndex={2} endIndex={3}>Second details</ReasoningGroup>
            </I18nProvider>
        )
        const [first, second] = screen.getAllByRole('button')
        expect(first).toHaveTextContent('Checking the first operation')
        expect(first).not.toHaveTextContent('Verifying the second operation')
        expect(second).toHaveTextContent('Verifying the second operation Checking its result')
        expect(second).not.toHaveTextContent('Checking the first operation')
        expect(first).toHaveTextContent('Reasoning')
        expect(second).not.toHaveTextContent('Reasoning')
        fireEvent.click(second!)
        expect(second).toHaveAttribute('aria-expanded', 'true')
        expect(second).not.toHaveTextContent('Verifying the second operation')
    })
})
