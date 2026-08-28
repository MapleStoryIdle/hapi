import { describe, expect, it } from 'vitest'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import {
    SessionDetailBottomDock,
    SessionDetailBottomDockAccessory,
    SessionDetailBottomDockComposer
} from './SessionDetailBottomDock'

describe('SessionDetailBottomDock', () => {
    it('keeps the composer anchor stable and floats the accessory above it', () => {
        const rootRef = createRef<HTMLDivElement>()
        const composerRef = createRef<HTMLDivElement>()
        const accessoryRef = createRef<HTMLDivElement>()

        render(
            <SessionDetailBottomDock ref={rootRef} testId="detail-bottom-dock">
                <SessionDetailBottomDockComposer ref={composerRef} testId="detail-composer">
                    Composer
                </SessionDetailBottomDockComposer>
                <SessionDetailBottomDockAccessory ref={accessoryRef} testId="detail-accessory">
                    Queue
                </SessionDetailBottomDockAccessory>
            </SessionDetailBottomDock>
        )

        expect(rootRef.current).toBe(screen.getByTestId('detail-bottom-dock'))
        expect(composerRef.current).toBe(screen.getByTestId('detail-composer'))
        expect(accessoryRef.current).toBe(screen.getByTestId('detail-accessory'))
        expect(screen.getByTestId('detail-bottom-dock')).toHaveClass('absolute')
        expect(screen.getByTestId('detail-accessory')).toHaveAttribute(
            'data-mobile-layout-contract',
            'floating-above-composer'
        )
        expect(screen.getByTestId('detail-accessory')).toHaveStyle({ bottom: 'calc(100% + 8px)' })
    })
})
