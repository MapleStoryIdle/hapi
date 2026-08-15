import type { ComponentProps, ReactElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    const React = await import('react')
    return {
        ...actual,
        ComposerPrimitive: {
            ...actual.ComposerPrimitive,
            AddAttachment: ({ children, ...props }: ComponentProps<'button'>) => React.createElement('button', props, children)
        }
    }
})

import { ComposerButtons, UnifiedButton, getComposerOptionalControlsVisibility, getRemoteServerButtonAlias } from './ComposerButtons'

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
        expect(btn.querySelector('span')?.className).toContain('bg-amber-500')
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
        expect(btn.querySelector('span')?.className).not.toContain('bg-amber-500')
        expect(btn.querySelector('span')?.className).toContain('bg-black')
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

    /**
     * Voice is temporarily hidden from the composer entry point. Empty input
     * should render the regular disabled send button, not the voice launcher.
     */
    it('shows disabled send instead of voice when empty input and voice is enabled', () => {
        const onVoiceToggle = vi.fn()

        renderInProviders(
            <UnifiedButton
                canSend={false}
                voiceStatus="disconnected"
                voiceEnabled
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={onVoiceToggle}
            />,
        )

        const btn = getButton('Send')
        expect(btn).toBeDisabled()
        expect(screen.queryByRole('button', { name: 'Voice assistant' })).not.toBeInTheDocument()

        fireEvent.click(btn)

        expect(onVoiceToggle).not.toHaveBeenCalled()
    })

    it('shows Send and sends a draft instead of aborting a running session', () => {
        const onSend = vi.fn()
        const onAbort = vi.fn()

        renderInProviders(
            <UnifiedButton
                canSend
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={onSend}
                onVoiceToggle={noop}
                showAbortButton
                abortDisabled={false}
                onAbort={onAbort}
            />,
        )

        expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument()
        fireEvent.click(getButton('Send'))

        expect(onSend).toHaveBeenCalledOnce()
        expect(onAbort).not.toHaveBeenCalled()
    })
})

describe('getRemoteServerButtonAlias', () => {
    /**
     * The composer status chip is space-constrained. It should display only
     * the operator-defined alias, not the longer server name / host tuple.
     */
    it('uses alias as the selected server display label', () => {
        expect(getRemoteServerButtonAlias({ alias: 'prod', name: 'Production Server' })).toBe('prod')
    })

    /**
     * Defensive fallback: persisted servers should always have aliases, but a
     * blank alias must not render an empty pill.
     */
    it('falls back to name when alias is blank', () => {
        expect(getRemoteServerButtonAlias({ alias: '   ', name: 'Production Server' })).toBe('Production Server')
    })
})

describe('getComposerOptionalControlsVisibility', () => {
    /**
     * Before ResizeObserver reports a real width, optional controls stay
     * visible so desktop/wide toolbars do not start in an artificial
     * "mobile" collapsed state.
     */
    it('shows optional controls before the toolbar is measured', () => {
        expect(getComposerOptionalControlsVisibility(null, 160)).toEqual({
            permission: true,
            contextUsage: true
        })
    })

    /**
     * Optional composer controls are gated by measured toolbar width, not a
     * viewport breakpoint. Permission appears first because it directly changes
     * execution risk; context usage can fall back to the grouped tools menu.
     */
    it('hides optional controls only when measured toolbar width is too tight', () => {
        expect(getComposerOptionalControlsVisibility(260, 160)).toEqual({
            permission: false,
            contextUsage: false
        })
        expect(getComposerOptionalControlsVisibility(280, 160)).toEqual({
            permission: true,
            contextUsage: false
        })
        expect(getComposerOptionalControlsVisibility(330, 160)).toEqual({
            permission: true,
            contextUsage: true
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 40)).toEqual({
            permission: true,
            contextUsage: false
        })
    })

    /**
     * When context usage is unavailable, permission should take the first
     * optional slot. Otherwise the row can show a wide blank middle while the
     * permission icon waits for space for a non-rendered context icon.
     */
    it('lets permission use the first optional slot when context usage is absent', () => {
        expect(getComposerOptionalControlsVisibility(260, 160, 0, false)).toEqual({
            permission: false,
            contextUsage: false
        })
        expect(getComposerOptionalControlsVisibility(280, 160, 0, false)).toEqual({
            permission: true,
            contextUsage: false
        })
    })

    /**
     * Skill is lower priority than permission and higher priority than
     * context usage. On tight widths it should be the control that falls
     * back into the "+" menu before permission, while context remains last.
     */
    it('places skill between permission and context usage in the optional priority order', () => {
        expect(getComposerOptionalControlsVisibility(280, 160, 0, true, true)).toEqual({
            permission: true,
            skill: false,
            contextUsage: false
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 0, true, true)).toEqual({
            permission: true,
            skill: true,
            contextUsage: false
        })
        expect(getComposerOptionalControlsVisibility(380, 160, 0, true, true)).toEqual({
            permission: true,
            skill: true,
            contextUsage: true
        })
    })

    /**
     * Status chips should consume their measured content width, not a fake
     * boolean reserve. If the status content is narrow, optional icons can use
     * the rest of the row.
     */
    it('uses measured status width when deciding which optional icons fit', () => {
        expect(getComposerOptionalControlsVisibility(330, 160, 12)).toEqual({
            permission: true,
            contextUsage: true
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 72)).toEqual({
            permission: false,
            contextUsage: false
        })
    })
})

describe('ComposerButtons — permission mode button', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    /**
     * Permission mode is visible when the toolbar has room, and remains inside
     * the grouped "+" menu for the mobile fallback.
     */
    it('shows permission mode when space is available and keeps it in the grouped tools menu', () => {
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

        expect(screen.getByRole('button', { name: /Permission Mode: Yolo/ })).toBeInTheDocument()
        const buttonsBeforeMenu = screen.getAllByRole('button')
        expect(buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: 'More tools' }))).toBeLessThan(
            buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: /Permission Mode: Yolo/ })),
        )
        expect(buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: /Permission Mode: Yolo/ }))).toBeLessThan(
            buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: 'Send' })),
        )

        fireEvent.click(screen.getByRole('button', { name: 'More tools' }))

        expect(screen.getByText('Input')).toBeInTheDocument()
        expect(screen.getByText('Execution')).toBeInTheDocument()

        const triggers = screen.getAllByRole('button', { name: /Permission Mode: Yolo/ })
        expect(triggers.length).toBeGreaterThanOrEqual(2)
        fireEvent.click(triggers[1]!)

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

describe('ComposerButtons — plan mode status control', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    /**
     * Active plan mode is represented above the composer by HappyComposer.
     * ComposerButtons keeps only the tool menu toggle and no longer renders
     * a second status chip in the bottom toolbar.
     */
    it('keeps active plan mode out of the bottom toolbar and toggles from the tools menu', () => {
        const onPlanModeToggle = vi.fn()

        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                showPlanModeButton
                planModeActive
                onPlanModeToggle={onPlanModeToggle}
                showTerminalButton={false}
                terminalDisabled={false}
                terminalLabel="Terminal"
                onTerminal={noop}
                showAbortButton
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

        const abortButton = screen.getByRole('button', { name: 'Abort' })
        expect(abortButton.querySelector('span')?.className).toContain('bg-red')
        expect(screen.queryByRole('button', { name: 'Exit Plan Mode' })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'More tools' }))
        fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }))

        expect(onPlanModeToggle).toHaveBeenCalledTimes(1)
    })
})

describe('ComposerButtons — compact composer layout', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    /**
     * Collapsed composer mode is intentionally sparse: the full status/action
     * row is hidden until the composer expands.
     */
    it('renders only the compact entry actions while collapsed', () => {
        renderInProviders(
            <ComposerButtons
                compact
                canSend={false}
                controlsDisabled={false}
                showSettingsButton
                onSettingsToggle={noop}
                settingsLabel="Settings"
                showPlanModeButton
                planModeActive={false}
                onPlanModeToggle={noop}
                showTerminalButton
                terminalDisabled={false}
                terminalLabel="Terminal"
                onTerminal={noop}
                showAbortButton
                abortDisabled={false}
                isAborting={false}
                onAbort={noop}
                showSwitchButton
                switchDisabled={false}
                isSwitching={false}
                onSwitch={noop}
                voiceEnabled={false}
                voiceStatus="disconnected"
                onVoiceToggle={noop}
                onSend={noop}
            />
        )

        expect(screen.getByRole('button', { name: 'More tools' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Abort' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument()
    })

    /**
     * Fast mode should be visible inside the model/settings pill without
     * changing the label text users already scan for model and reasoning.
     */
    it('renders a lightning icon at the start of the settings pill in fast mode', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton
                onSettingsToggle={noop}
                settingsLabel="Settings"
                settingsModelLabel="5.5"
                settingsReasoningLabel="超高"
                fastModeActive
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

        const settingsButton = screen.getByRole('button', { name: 'Settings' })
        expect(screen.getByTestId('composer-fast-mode-icon')).toBeInTheDocument()
        expect(settingsButton.textContent).toContain('5.5')
        expect(settingsButton.textContent).toContain('超高')
    })
})

describe('ComposerButtons — skill picker', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    it('groups skills by scope without tab or count badges', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                skills={[
                    { name: 'plugin-beta', description: 'Plugin skill', scope: 'plugin' },
                    { name: 'project-bravo', description: 'Project skill', scope: 'project' },
                    { name: 'system-delta', description: 'System skill', scope: 'system' },
                    { name: 'global-alpha', description: 'Global skill', scope: 'user' },
                ]}
                onSkillSelect={noop}
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

        fireEvent.click(screen.getByRole('button', { name: 'Skills' }))

        const projectSkill = screen.getByText('project-bravo')
        const globalSkill = screen.getByText('global-alpha')
        const pluginSkill = screen.getByText('plugin-beta')
        const systemSkill = screen.getByText('system-delta')
        expect(projectSkill.compareDocumentPosition(globalSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(globalSkill.compareDocumentPosition(pluginSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(pluginSkill.compareDocumentPosition(systemSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.queryByRole('button', { name: /Custom\s+\d/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Other\s+\d/ })).not.toBeInTheDocument()
        expect(screen.queryByText('4')).not.toBeInTheDocument()
    })
})

describe('ComposerButtons — context usage popover', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    it('opens the context usage popover from the hollow ring indicator', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                contextUsagePercent={4}
                contextUsageLabel="ctx 10.2K/258.4K (96% left)"
                contextUsageDetails={{
                    usedTokens: 10_200,
                    windowTokens: 258_400,
                    cacheReadTokens: 12_400,
                    source: 'model',
                    usedLabel: '10.2K',
                    remainingLabel: '248.2K',
                    windowLabel: '258.4K',
                    cacheReadLabel: '12.4K',
                    remainingPercent: 96
                }}
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

        const trigger = screen.getByRole('button', { name: /ctx 10\.2K\/258\.4K/ })
        expect(trigger).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(trigger)

        expect(trigger).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('Context')).toBeInTheDocument()
        expect(screen.getByText('Model window · 258.4K')).toBeInTheDocument()
        expect(screen.getByText('10.2K')).toBeInTheDocument()
        expect(screen.getByText('248.2K')).toBeInTheDocument()
        expect(screen.getByText('258.4K')).toBeInTheDocument()
        expect(screen.getByText('96% remaining')).toBeInTheDocument()
        expect(screen.getByText('Cached 12.4K')).toBeInTheDocument()
    })
})
