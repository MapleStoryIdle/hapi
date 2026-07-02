import type { ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ComposerButtons, UnifiedButton } from './ComposerButtons'

function renderInProviders(ui: ReactElement) {
    return render(<I18nProvider>{ui}</I18nProvider>)
}

/**
 * Regression tests for upstream review on PR #798
 * (github-actions[bot] [Major]: "Send button advertises scratchlist
 * routing even when the submit will go to chat").
 *
 * UnifiedButton's visible state (amber + "Send to scratchlist" label
 * vs. black + "Send message" label) MUST reflect the actual routing
 * decision rather than the raw scratchlist toggle. Callers are
 * responsible for computing routesToScratchlist from
 * (mode, attachments, schedule); these tests pin the contract that
 * routesToScratchlist=false drives the chat-style render.
 */

function getButton(label: RegExp | string): HTMLButtonElement {
    return screen.getByRole('button', { name: label }) as HTMLButtonElement
}

describe('UnifiedButton — routesToScratchlist visual state', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    it('paints amber + announces "Send to scratchlist" when routesToScratchlist=true', () => {
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
                routesToScratchlist
            />,
        )
        const btn = getButton(/scratchlist/i)
        expect(btn.className).toContain('bg-amber-500')
    })

    it('paints chat black + announces "Send" when routesToScratchlist=false even if scratchlist toggle conceptually on', () => {
        // Caller computed routesToScratchlist=false because the payload
        // would carry attachments or a pending schedule. The button must
        // therefore look like a normal chat send.
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
                routesToScratchlist={false}
            />,
        )
        const btn = getButton('Send')
        expect(btn.className).not.toContain('bg-amber-500')
        expect(btn.className).toContain('bg-black')
    })

    it('defaults routesToScratchlist to false when omitted', () => {
        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
            />,
        )
        const btn = getButton('Send')
        expect(btn.className).not.toContain('bg-amber-500')
    })
})

describe('ComposerButtons — permission mode button', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    /**
     * Verifies the composer permission control stays icon-only while the
     * expanded menu carries the readable mode labels and descriptions.
     */
    it('renders the permission mode trigger as icon-only and shows rich menu rows', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                permissionMode="yolo"
                permissionLabel="Yolo"
                permissionModeOptions={[
                    { mode: 'default', label: 'Default' },
                    { mode: 'read-only', label: 'Read Only' },
                    { mode: 'safe-yolo', label: 'Safe Yolo' },
                    { mode: 'yolo', label: 'Yolo' }
                ]}
                onPermissionModeChange={noop}
                showTerminalButton={false}
                terminalDisabled={false}
                terminalLabel="Terminal"
                onTerminal={noop}
                showAbortButton={false}
                abortDisabled={false}
                isAborting={false}
                onAbort={noop}
                showSwitchButton={false}
                switchDisabled={false}
                isSwitching={false}
                onSwitch={noop}
                voiceEnabled={false}
                voiceStatus="disconnected"
                onVoiceToggle={noop}
                onSend={noop}
            />
        )

        const trigger = screen.getByRole('button', { name: /Permission Mode: Yolo/ })
        expect(trigger.textContent).toBe('')
        expect(screen.queryByText('Yolo')).not.toBeInTheDocument()

        fireEvent.click(trigger)

        expect(screen.getByText('Full Access')).toBeInTheDocument()
        expect(screen.getByText('Full computer access (higher risk)')).toBeInTheDocument()
        const defaultRow = screen.getByText('Request Approval').closest('button')
        const safeYoloRow = screen.getByText('Approve For Me').closest('button')
        const fullAccessRow = screen.getByText('Full Access').closest('button')
        expect(defaultRow?.querySelector('span')?.className).toContain('text-black/55')
        expect(safeYoloRow?.querySelector('span')?.className).not.toContain('text-orange-500')
        expect(safeYoloRow?.querySelector('span')?.className).toContain('text-blue-500')
        expect(fullAccessRow?.querySelector('span')?.className).toContain('text-orange-500')
    })
})
