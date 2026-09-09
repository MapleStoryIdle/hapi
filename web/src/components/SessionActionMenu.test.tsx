import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionActionMenu } from '@/components/SessionActionMenu'

afterEach(() => cleanup())

function renderMenu(overrides: Partial<React.ComponentProps<typeof SessionActionMenu>> = {}) {
    const defaults: React.ComponentProps<typeof SessionActionMenu> = {
        isOpen: true,
        onClose: vi.fn(),
        sessionActive: false,
        onRename: vi.fn(),
        onArchive: vi.fn(),
        onReopen: vi.fn(),
        onDelete: vi.fn(),
        anchorPoint: { x: 0, y: 0 },
    }
    const merged = { ...defaults, ...overrides }
    return {
        ...render(
            <I18nProvider>
                <SessionActionMenu {...merged} />
            </I18nProvider>
        ),
        props: merged
    }
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('SessionActionMenu - Reopen action', () => {
    it('renders the Reopen item on inactive sessions when onReopen is provided', () => {
        renderMenu({ sessionActive: false })

        expect(screen.getByRole('menuitem', { name: /Reopen/ })).toBeInTheDocument()
    })

    it('does not render the Reopen item on active sessions', () => {
        renderMenu({ sessionActive: true })

        expect(screen.queryByRole('menuitem', { name: /Reopen/ })).toBeNull()
    })

    it('does not render the Reopen item when onReopen is omitted (back-compat)', () => {
        renderMenu({ sessionActive: false, onReopen: undefined })

        expect(screen.queryByRole('menuitem', { name: /Reopen/ })).toBeNull()
        // Delete item is still present for inactive sessions.
        expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
    })

    it('fires onReopen and closes the menu when the Reopen item is clicked', () => {
        const onReopen = vi.fn()
        const onClose = vi.fn()
        renderMenu({ sessionActive: false, onReopen, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: /Reopen/ }))

        expect(onReopen).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders Reopen alongside Delete for inactive sessions', () => {
        renderMenu({ sessionActive: false })

        expect(screen.getByRole('menuitem', { name: /Reopen/ })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument()
        // Archive should not show up for inactive sessions (it is the active-session destructive).
        expect(screen.queryByRole('menuitem', { name: /Archive/ })).toBeNull()
    })
})

describe('SessionActionMenu - capability-scoped actions', () => {
    it('orders compact primary actions before lifecycle actions', () => {
        renderMenu({ onToggleFiles: vi.fn(), onGitBranches: vi.fn(), onFork: vi.fn(), onCreateMonitor: vi.fn() })
        expect(screen.getAllByRole('menuitem').slice(0, 4).map(item => item.textContent)).toEqual(['Files', 'Git', 'Fork', 'Monitor'])
    })

    it('creates a monitor and closes the menu when the source session supports it', () => {
        const onCreateMonitor = vi.fn()
        const onClose = vi.fn()
        renderMenu({ onCreateMonitor, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Monitor' }))

        expect(onCreateMonitor).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('opens the shared Git branch picker entry when a Git project is available', () => {
        const onGitBranches = vi.fn()
        const onClose = vi.fn()
        renderMenu({ onGitBranches, onClose })

        fireEvent.click(screen.getByRole('menuitem', { name: 'Git' }))

        expect(onGitBranches).toHaveBeenCalledTimes(1)
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('supports a native-session menu without rendering SHAPI lifecycle actions', () => {
        const onRefresh = vi.fn()
        const onFork = vi.fn()
        renderMenu({
            sessionActive: true,
            onRefresh,
            refreshLabel: 'Refresh native session',
            onFork,
            forkLabel: 'Fork native session',
            onRename: undefined,
            onExport: undefined,
            onArchive: undefined,
            onReopen: undefined,
            onDelete: undefined,
            onToggleOutline: vi.fn(),
        })

        expect(screen.getByRole('menuitem', { name: 'Refresh native session' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: 'Fork native session' })).toBeInTheDocument()
        expect(screen.getByRole('menuitem', { name: /Conversation outline/ })).toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /Rename/ })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /Archive/ })).toBeNull()
        expect(screen.queryByRole('menuitem', { name: /Delete/ })).toBeNull()

        fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh native session' }))
        expect(onRefresh).toHaveBeenCalledTimes(1)
    })

    it('disables Fork while a native turn is not safe to fork', () => {
        const onFork = vi.fn()
        renderMenu({
            sessionActive: true,
            onRename: undefined,
            onExport: undefined,
            onArchive: undefined,
            onReopen: undefined,
            onDelete: undefined,
            onFork,
            forkLabel: 'Fork native session',
            forkDisabled: true,
        })

        const forkItem = screen.getByRole('menuitem', { name: 'Fork native session' })
        expect(forkItem).toBeDisabled()
        fireEvent.click(forkItem)
        expect(onFork).not.toHaveBeenCalled()
    })
})
