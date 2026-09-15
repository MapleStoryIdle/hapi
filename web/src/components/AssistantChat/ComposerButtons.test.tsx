import type { ComponentProps, ReactElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

import { ComposerButtons, ContextUsageProgressRail, UnifiedButton, computeToolbarMenuPlacement, getComposerOptionalControlsVisibility } from './ComposerButtons'

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

    it('morphs the active voice control from microphone to stop', () => {
        const view = renderInProviders(
            <UnifiedButton
                canSend={false}
                voiceStatus="connecting"
                voiceEnabled
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
            />,
        )

        expect(view.container.querySelector('[data-motion-icon="mic"]')).not.toBeNull()

        view.rerender(
            <I18nProvider>
                <UnifiedButton
                    canSend={false}
                    voiceStatus="connected"
                    voiceEnabled
                    controlsDisabled={false}
                    onSend={noop}
                    onVoiceToggle={noop}
                />
            </I18nProvider>,
        )

        expect(view.container.querySelector('[data-motion-icon="square"]')).not.toBeNull()
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

    it('adds a breathing animation to an available abort button', () => {
        renderInProviders(
            <UnifiedButton
                canSend={false}
                voiceStatus="disconnected"
                voiceEnabled={false}
                controlsDisabled={false}
                onSend={noop}
                onVoiceToggle={noop}
                showAbortButton
                abortDisabled={false}
                onAbort={noop}
            />,
        )

        expect(getButton('Abort').querySelector('span')?.className).toContain('animate-stop-button-breathe')
    })

    it('preserves the iOS click sequence while retaining composer focus for Send', () => {
        const onParentPointerDown = vi.fn()
        const onParentMouseDown = vi.fn()
        const onSend = vi.fn()

        renderInProviders(
            <div
                onPointerDown={(event) => onParentPointerDown(event.defaultPrevented)}
                onMouseDown={(event) => onParentMouseDown(event.defaultPrevented)}
            >
                <UnifiedButton
                    canSend
                    voiceStatus="disconnected"
                    voiceEnabled={false}
                    controlsDisabled={false}
                    onSend={onSend}
                    onVoiceToggle={noop}
                />
            </div>,
        )

        const button = getButton('Send')
        fireEvent.pointerDown(button)
        fireEvent.mouseDown(button)
        fireEvent.click(button)

        // Cancelling pointerdown can suppress iOS's compatibility mouse and
        // click events. Focus retention must happen at mousedown instead.
        expect(onParentPointerDown).toHaveBeenCalledWith(false)
        expect(onParentMouseDown).toHaveBeenCalledWith(true)
        expect(onSend).toHaveBeenCalledOnce()
    })
})

describe('computeToolbarMenuPlacement', () => {
    it('caps a keyboard-open menu to the tappable visual viewport above its toolbar', () => {
        const placement = computeToolbarMenuPlacement({
            anchor: { top: 246, right: 382, bottom: 288, left: 340, width: 42 },
            panelWidth: 210,
            panelHeight: 320,
            viewport: { width: 390, height: 300 },
            align: 'right'
        })

        expect(placement.placement).toBe('above')
        expect(placement.top).toBe(8)
        expect(placement.maxHeight).toBe(230)
        expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(238)
    })

    it('uses the visible viewport when the keyboard leaves no usable adjacent space', () => {
        const placement = computeToolbarMenuPlacement({
            anchor: { top: 50, right: 302, bottom: 92, left: 260, width: 42 },
            panelWidth: 340,
            panelHeight: 320,
            viewport: { width: 320, height: 130 },
            align: 'right'
        })

        expect(placement.placement).toBe('viewport')
        expect(placement.top).toBe(8)
        expect(placement.left).toBe(8)
        expect(placement.width).toBe(304)
        expect(placement.maxHeight).toBe(114)
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
            permission: true
        })
    })

    /**
     * Optional composer controls are gated by measured toolbar width, not a
     * viewport breakpoint. Permission appears first because it directly changes
     * execution risk; context usage lives in the bottom progress rail.
     */
    it('hides optional controls only when measured toolbar width is too tight', () => {
        expect(getComposerOptionalControlsVisibility(260, 160)).toEqual({
            permission: false
        })
        expect(getComposerOptionalControlsVisibility(280, 160)).toEqual({
            permission: true
        })
        expect(getComposerOptionalControlsVisibility(330, 160)).toEqual({
            permission: true
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 40)).toEqual({
            permission: true
        })
    })

    /**
     * Permission remains in the first optional slot when no skill picker is
     * available.
     */
    it('lets permission use the first optional slot when skills are absent', () => {
        expect(getComposerOptionalControlsVisibility(260, 160, 0, false)).toEqual({
            permission: false
        })
        expect(getComposerOptionalControlsVisibility(280, 160, 0, false)).toEqual({
            permission: true
        })
    })

    /**
     * Skill is lower priority than permission. On tight widths it falls back
     * into the "+" menu before permission.
     */
    it('places skill after permission in the optional priority order', () => {
        expect(getComposerOptionalControlsVisibility(280, 160, 0, true, true)).toEqual({
            permission: true,
            skill: false
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 0, true, true)).toEqual({
            permission: true,
            skill: true
        })
        expect(getComposerOptionalControlsVisibility(380, 160, 0, true, true)).toEqual({
            permission: true,
            skill: true
        })
        expect(getComposerOptionalControlsVisibility(305, 160, 0, true, true)).toEqual({
            permission: true,
            skill: false
        })
        expect(getComposerOptionalControlsVisibility(306, 160, 0, true, true)).toEqual({
            permission: true,
            skill: true
        })
    })

    /**
     * Status chips should consume their measured content width, not a fake
     * boolean reserve. If the status content is narrow, optional icons can use
     * the rest of the row.
     */
    it('uses measured status width when deciding which optional icons fit', () => {
        expect(getComposerOptionalControlsVisibility(330, 160, 12)).toEqual({
            permission: true
        })
        expect(getComposerOptionalControlsVisibility(330, 160, 72)).toEqual({
            permission: false
        })
    })
})

describe('ComposerButtons — permission mode button', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
        document.documentElement.removeAttribute('data-app-keyboard-open')
    })

    /**
     * Permission mode is visible when the toolbar has room, and remains inside
     * the grouped "+" menu for the mobile fallback.
     */
    it('shows permission mode when space is available and keeps it in the grouped tools menu', () => {
        const onParentPointerDown = vi.fn()

        renderInProviders(
            <div onPointerDown={(event) => onParentPointerDown(event.defaultPrevented)}>
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
            </div>
        )

        expect(screen.getByRole('button', { name: /Permission Mode: Yolo/ })).toBeInTheDocument()
        const buttonsBeforeMenu = screen.getAllByRole('button')
        expect(buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: 'More tools' }))).toBeLessThan(
            buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: /Permission Mode: Yolo/ })),
        )
        expect(buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: /Permission Mode: Yolo/ }))).toBeLessThan(
            buttonsBeforeMenu.indexOf(screen.getByRole('button', { name: 'Send' })),
        )

        const moreToolsButton = screen.getByRole('button', { name: 'More tools' })
        fireEvent.pointerDown(moreToolsButton)
        // The iOS click path must remain intact; focus is retained at
        // mousedown by HappyComposer, never by cancelling pointerdown.
        expect(onParentPointerDown).toHaveBeenCalledWith(false)
        fireEvent.click(moreToolsButton)

        expect(screen.getByText('Input')).toBeInTheDocument()
        expect(screen.getByText('Execution')).toBeInTheDocument()

        const triggers = screen.getAllByRole('button', { name: /Permission Mode: Yolo/ })
        expect(triggers.length).toBeGreaterThanOrEqual(2)
        fireEvent.click(triggers[1]!)

        expect(screen.getByText('Full Access')).toBeInTheDocument()
        expect(screen.getByText('Full computer access (higher risk)')).toBeInTheDocument()
        const defaultRow = screen.getByText('Request Approval').closest('button')
        const readOnlyRow = screen.getByText('Read Only').closest('button')
        const safeYoloRow = screen.getByText('Approve For Me').closest('button')
        const fullAccessRow = screen.getByText('Full Access').closest('button')
        expect(readOnlyRow?.querySelector('.lucide-eye')).toBeInTheDocument()
        expect(defaultRow?.querySelector('.lucide-eye')).not.toBeInTheDocument()
        expect(readOnlyRow!.compareDocumentPosition(defaultRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(defaultRow?.querySelector('span')?.className).toContain('text-black/55')
        expect(safeYoloRow?.querySelector('span')?.className).not.toContain('text-orange-500')
        expect(safeYoloRow?.querySelector('span')?.className).toContain('text-blue-500')
        expect(fullAccessRow?.querySelector('span')?.className).toContain('text-orange-500')
    })

    it('keeps the keyboard-open permission menu in the shared viewport scroll layer', () => {
        document.documentElement.setAttribute('data-app-keyboard-open', 'true')
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                permissionMode="default"
                permissionLabel="Default"
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

        fireEvent.click(screen.getByRole('button', { name: /Permission Mode: Default/ }))

        const menu = screen.getByTestId('toolbar-menu')
        const scrollLayer = menu.querySelector('[data-toolbar-menu-scroll="true"]')
        expect(menu.parentElement).toBe(document.body)
        expect(menu).toHaveAttribute('data-toolbar-menu-surface', 'permission')
        expect(scrollLayer).toHaveClass('overflow-y-auto', 'overscroll-contain')
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
        localStorage.clear()
        document.documentElement.removeAttribute('data-app-keyboard-open')
    })

    it('puts Hub below Project and keeps scope groups collapsed with counts', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                skills={[
                    { name: 'plugin-beta', description: 'Plugin skill', scope: 'plugin' },
                    { name: 'project-bravo', description: 'Project skill', scope: 'project' },
                    { name: 'public-share', description: 'Hub skill', scope: 'hub' },
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

        const hubSection = screen.getByTestId('composer-skill-section-hub')
        const projectSection = screen.getByTestId('composer-skill-section-project')
        expect(screen.getByTestId('composer-skill-total')).toHaveTextContent('5')
        expect(screen.queryByPlaceholderText('Search skills')).not.toBeInTheDocument()
        expect(hubSection).toHaveAttribute('aria-expanded', 'false')
        expect(hubSection).toHaveTextContent('Hub')
        expect(hubSection).toHaveTextContent('1')
        expect(projectSection.compareDocumentPosition(hubSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.queryByText('Public Share')).not.toBeInTheDocument()

        fireEvent.click(hubSection)
        const hubSkill = screen.getByText('Public Share')
        expect(hubSection.compareDocumentPosition(hubSkill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

        for (const section of ['project', 'user', 'plugin', 'system']) {
            const button = screen.getByTestId(`composer-skill-section-${section}`)
            expect(button).toHaveAttribute('aria-expanded', 'false')
            expect(button).toHaveTextContent('1')
        }
        expect(screen.queryByText('project-bravo')).not.toBeInTheDocument()
        expect(screen.queryByText('global-alpha')).not.toBeInTheDocument()

        fireEvent.click(screen.getByTestId('composer-skill-section-project'))
        expect(screen.getByText('project-bravo')).toBeInTheDocument()
    })

    it('shows the last deliberately clicked skills for the current project only', () => {
        const skills = [
            { name: 'first', description: 'First skill', scope: 'project' as const },
            { name: 'second', description: 'Second skill', scope: 'project' as const },
        ]
        const props = {
            canSend: false,
            controlsDisabled: false,
            showSettingsButton: false,
            onSettingsToggle: noop,
            skills,
            onSkillSelect: noop,
            showTerminalButton: false,
            terminalDisabled: false,
            terminalLabel: 'Terminal',
            onTerminal: noop,
            showAbortButton: false,
            abortDisabled: false,
            isAborting: false,
            onAbort: noop,
            showSwitchButton: false,
            switchDisabled: false,
            isSwitching: false,
            onSwitch: noop,
            voiceEnabled: false,
            voiceStatus: 'disconnected' as const,
            onVoiceToggle: noop,
            onSend: noop,
        }

        const view = renderInProviders(<ComposerButtons {...props} projectPath="/work/alpha" />)
        fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
        fireEvent.click(screen.getByTestId('composer-skill-section-project'))
        fireEvent.click(screen.getByText('second'))
        fireEvent.click(screen.getByRole('button', { name: 'Skills' }))

        const recent = screen.getByTestId('composer-recent-skills')
        expect(within(recent).getByText('Recent')).toBeInTheDocument()
        expect(screen.getByTestId('composer-skill-section-recent')).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByTestId('composer-skill-section-recent')).toHaveTextContent('1')
        expect(within(recent).getByText('second')).toBeInTheDocument()

        view.rerender(
            <I18nProvider>
                <ComposerButtons {...props} projectPath="/work/beta" />
            </I18nProvider>
        )
        expect(screen.queryByTestId('composer-recent-skills')).not.toBeInTheDocument()
    })

    it('keeps the keyboard focus stable and portals the menu to the viewport layer', () => {
        document.documentElement.setAttribute('data-app-keyboard-open', 'true')
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
                projectPath="/work/alpha"
                skills={[{ name: 'project-skill', scope: 'project' }]}
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

        const menu = screen.getByTestId('toolbar-menu')
        expect(screen.queryByPlaceholderText('Search skills')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Show skill filters' }))
        const search = screen.getByPlaceholderText('Search skills')
        expect(menu.parentElement).toBe(document.body)
        expect(search).not.toHaveFocus()
    })

    it('shows the last entered skill search instead of a fixed lark filter', () => {
        const props = {
            canSend: false,
            controlsDisabled: false,
            showSettingsButton: false,
            onSettingsToggle: noop,
            skills: [
                { name: 'lark-doc', scope: 'plugin' as const },
                { name: 'public-share', scope: 'hub' as const }
            ],
            onSkillSelect: noop,
            showTerminalButton: false,
            terminalDisabled: false,
            terminalLabel: 'Terminal',
            onTerminal: noop,
            showAbortButton: false,
            abortDisabled: false,
            isAborting: false,
            onAbort: noop,
            showSwitchButton: false,
            switchDisabled: false,
            isSwitching: false,
            onSwitch: noop,
            voiceEnabled: false,
            voiceStatus: 'disconnected' as const,
            onVoiceToggle: noop,
            onSend: noop,
        }

        const first = renderInProviders(<ComposerButtons {...props} />)
        fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
        fireEvent.click(screen.getByTestId('composer-skill-section-plugin'))
        expect(screen.getByText('lark-doc')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Show skill filters' }))
        expect(screen.queryByRole('button', { name: /lark- skills/i })).not.toBeInTheDocument()
        fireEvent.change(screen.getByPlaceholderText('Search skills'), { target: { value: 'share' } })
        first.unmount()

        renderInProviders(<ComposerButtons {...props} />)
        fireEvent.click(screen.getByRole('button', { name: 'Skills' }))
        fireEvent.click(screen.getByRole('button', { name: 'Show skill filters' }))
        const recentSearch = screen.getByRole('button', { name: 'Use recent search: share' })
        expect(recentSearch).toHaveTextContent('share')
        fireEvent.click(recentSearch)
        expect(screen.getByPlaceholderText('Search skills')).toHaveValue('share')
    })
})

describe('ComposerButtons — context usage popover', () => {
    const noop = () => {}

    afterEach(() => {
        cleanup()
    })

    it('opens the context usage popover from the grouped tools menu', () => {
        renderInProviders(
            <ComposerButtons
                canSend={false}
                controlsDisabled={false}
                showSettingsButton={false}
                onSettingsToggle={noop}
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

        expect(screen.queryByRole('button', { name: /ctx 10\.2K\/258\.4K/ })).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'More tools' }))

        const trigger = screen.getByRole('button', { name: /ctx 10\.2K\/258\.4K/ })
        fireEvent.click(trigger)

        expect(screen.getByText('Context')).toBeInTheDocument()
        expect(screen.getByText('Model window · 258.4K')).toBeInTheDocument()
        expect(screen.getByText('10.2K')).toBeInTheDocument()
        expect(screen.getByText('248.2K')).toBeInTheDocument()
        expect(screen.getByText('258.4K')).toBeInTheDocument()
        expect(screen.getByText('96% remaining')).toBeInTheDocument()
        expect(screen.getByText('Cached 12.4K')).toBeInTheDocument()
    })
})

describe('ContextUsageProgressRail', () => {
    afterEach(() => {
        cleanup()
    })

    it('renders an inset semantic progress rail with the used-context percentage', () => {
        render(
            <ContextUsageProgressRail
                percentage={78.4}
                label="ctx 202.6K/258.4K (22% left)"
            />
        )

        const rail = screen.getByRole('progressbar', { name: /ctx 202\.6K\/258\.4K/ })
        expect(rail).toHaveAttribute('aria-valuenow', '78')
        expect(rail).toHaveClass('inset-x-3', 'bottom-0', 'h-[3px]')
        expect(rail.firstElementChild).toHaveStyle({ width: '78.4%' })
        expect(rail.firstElementChild?.className).toContain('bg-amber-500')
    })

    it('hides when no percentage can be calculated', () => {
        render(<ContextUsageProgressRail percentage={null} />)

        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })
})

describe('shared model control read-only state', () => {
    afterEach(cleanup)

    it.each([true, false])('uses the shared style and only allows editable controls to open (readOnly=%s)', (readOnly) => {
        const toggle = vi.fn()
        const noop = () => {}
        renderInProviders(
            <ComposerButtons
                canSend={false} controlsDisabled={false} showSettingsButton
                settingsReadOnly={readOnly} onSettingsToggle={toggle}
                settingsLabel="gpt-5.6-terra high" settingsModelLabel="5.6-terra" settingsReasoningLabel="high"
                showTerminalButton={false} terminalDisabled={false} terminalLabel="Terminal" onTerminal={noop}
                showAbortButton={false} abortDisabled={false} isAborting={false} onAbort={noop}
                showSwitchButton={false} switchDisabled={false} isSwitching={false} onSwitch={noop}
                voiceEnabled={false} voiceStatus="disconnected" onVoiceToggle={noop} onSend={noop}
            />
        )
        const button = screen.getByRole('button', { name: readOnly ? /Current model:.*read-only/ : 'Settings' })
        expect(button).toHaveClass('settings-button')
        expect(button).toHaveTextContent('5.6-terra')
        expect(button).toHaveTextContent('high')
        if (readOnly) expect(button).toBeDisabled()
        else expect(button).toBeEnabled()
        fireEvent.click(button)
        expect(toggle).toHaveBeenCalledTimes(readOnly ? 0 : 1)
    })
})
