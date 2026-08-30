import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { ActionButtons } from './ActionButtons'

describe('ActionButtons', () => {
    it('pins a secondary cancel action left of the primary create action', () => {
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
        const [cancelButton, createButton] = Array.from(footer.querySelectorAll('button'))
        expect([cancelButton, createButton].map((button) => button.textContent)).toEqual([
            'button.cancel',
            'newSession.create'
        ])
        expect(cancelButton.className).not.toContain('flex-1')
        expect(createButton.className).toContain('flex-1')

        fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))
        fireEvent.click(screen.getByRole('button', { name: 'newSession.create' }))

        expect(onCancel).toHaveBeenCalledOnce()
        expect(onCreate).toHaveBeenCalledOnce()
    })
})
