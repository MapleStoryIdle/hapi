import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { YoloToggle } from './YoloToggle'

afterEach(() => {
    cleanup()
})

describe('YoloToggle', () => {
    it('shows the risk explanation beside the agent settings only when YOLO is selected', () => {
        const { rerender } = render(
            <YoloToggle yoloMode={false} isDisabled={false} inline onToggle={() => {}} />
        )

        expect(screen.queryByText('newSession.yolo.desc')).toBeNull()

        rerender(
            <YoloToggle yoloMode isDisabled={false} inline onToggle={() => {}} />
        )

        expect(screen.getByText('newSession.yolo.desc')).toBeTruthy()
    })
})
