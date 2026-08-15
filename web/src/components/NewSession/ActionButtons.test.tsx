import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { ActionButtons } from './ActionButtons'

describe('ActionButtons', () => {
    it('pins cancel left and create right in one bottom action row', () => {
        const onCancel = vi.fn()
        const onCreate = vi.fn()
        const { getByTestId } = render(
            <ActionButtons
                isPending={false}
                canCreate={true}
                isDisabled={false}
                onCancel={onCancel}
                onCreate={onCreate}
            />
        )

        const footer = getByTestId('new-session-actions')
        expect(footer.className).toContain('fixed')
        expect(footer.className).toContain('bottom-0')
        expect(Array.from(footer.querySelectorAll('button')).map((button) => button.textContent)).toEqual([
            'button.cancel',
            'newSession.create'
        ])

        fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))
        fireEvent.click(screen.getByRole('button', { name: 'newSession.create' }))

        expect(onCancel).toHaveBeenCalledOnce()
        expect(onCreate).toHaveBeenCalledOnce()
    })
})
