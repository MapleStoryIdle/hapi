import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { TerminalExecutionDrawer } from '@/components/ToolCard/TerminalExecutionDrawer'
import { I18nProvider } from '@/lib/i18n-context'

function makeBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'terminal-drawer',
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id: 'terminal-drawer',
            name: 'CodexBash',
            state: 'completed',
            input: {
                command: '/bin/zsh -lc "bun run test:web"',
                cwd: '/workspace/hapi',
            },
            result: {
                stdout: '1418 tests passed',
                exit_code: 0,
            },
            createdAt: 100,
            startedAt: 200,
            completedAt: 2_450,
            description: null,
        }
    }
}

function DrawerHarness() {
    const [open, setOpen] = useState(true)
    return <TerminalExecutionDrawer block={makeBlock()} open={open} onOpenChange={setOpen} />
}

function firePointerEvent(target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientY: number) {
    const event = createEvent(type, target, { bubbles: true, cancelable: true })
    Object.defineProperties(event, {
        pointerId: { value: 1 },
        pointerType: { value: 'touch' },
        clientY: { value: clientY },
    })
    fireEvent(target, event)
}

describe('TerminalExecutionDrawer', () => {
    afterEach(() => {
        cleanup()
    })

    it('uses a bottom sheet on mobile and a wide side drawer on larger screens', () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        const drawer = screen.getByTestId('terminal-execution-drawer')
        expect(drawer).toHaveClass(
            'bottom-0',
            'h-[min(88dvh,50rem)]',
            'rounded-t-[28px]',
            'isolate',
            'sm:right-0',
            'sm:h-auto',
            'sm:w-[min(46rem,58vw)]'
        )
        expect(drawer).toHaveTextContent('Terminal execution')
        expect(drawer).toHaveTextContent('Completed')
        expect(drawer).toHaveTextContent('2.3s')
        expect(drawer).toHaveTextContent('/bin/zsh -lc "bun run test:web"')
        expect(drawer).toHaveTextContent('1418 tests passed')
        expect(drawer.querySelector('[data-terminal-execution-overview]')).not.toBeInTheDocument()
        expect(drawer.querySelector('header')).toHaveClass('relative', 'z-10', 'bg-[var(--app-dialog-bg)]')
        expect(drawer.querySelector('[data-terminal-execution-detail]')).toHaveClass('relative', 'isolate', 'flex-1', 'overscroll-contain')
        expect(drawer.querySelector('[data-terminal-execution-input]')).toHaveClass('shrink-0')
        expect(drawer.querySelector('[data-terminal-execution-output]')).toHaveClass('shrink-0')
    })

    it('closes through the drawer close control', async () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Close' }))

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })

    it('closes when the mobile handle is dragged down far enough', async () => {
        render(
            <I18nProvider>
                <DrawerHarness />
            </I18nProvider>
        )

        const handle = screen.getByTestId('terminal-execution-drawer-drag-handle')
        firePointerEvent(handle, 'pointerdown', 100)
        firePointerEvent(handle, 'pointermove', 220)

        await waitFor(() => {
            expect(screen.getByTestId('terminal-execution-drawer')).toHaveStyle({ transform: 'translate3d(0, 120px, 0)' })
        })

        firePointerEvent(handle, 'pointerup', 220)

        await waitFor(() => {
            expect(screen.queryByTestId('terminal-execution-drawer')).not.toBeInTheDocument()
        })
    })
})
