import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { AgentFlavorIcon, AgentFlavorStatusIcon } from './AgentFlavorIcon'

function getBadge(container: HTMLElement): HTMLElement {
    const badge = container.querySelector('span')
    if (!badge) throw new Error('AgentFlavorIcon did not render a <span>')
    return badge
}

describe('AgentFlavorIcon', () => {
    it('renders official SVG icons for flavors present in @lobehub/icons', () => {
        // These flavors have official icon components in @lobehub/icons; the
        // UI should no longer render the old two-letter text badge for them.
        const cases: Array<{ flavor: string; title: string; oldLabel: string }> = [
            { flavor: 'claude', title: 'Claude Code', oldLabel: 'Cl' },
            { flavor: 'codex', title: 'Codex', oldLabel: 'Cx' },
            { flavor: 'cursor', title: 'Cursor', oldLabel: 'Cu' },
            { flavor: 'gemini', title: 'Gemini CLI', oldLabel: 'Gm' },
            { flavor: 'kimi', title: 'Kimi', oldLabel: 'Km' },
            { flavor: 'opencode', title: 'OpenCode', oldLabel: 'Op' },
        ]

        for (const { flavor, title, oldLabel } of cases) {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            const badge = getBadge(container)
            expect(badge.querySelector('svg')).toBeTruthy()
            expect(badge.title).toBe(title)
            expect(badge.textContent).not.toBe(oldLabel)
        }
    })

    it('renders the "Pi" text fallback and purple background for the pi flavor', () => {
        // Pi has no dedicated official icon in the installed icon catalog, so it
        // intentionally keeps the branded fallback badge.
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Pi')
        // The Pi badge uses a specific purple; if the literal ever drifts,
        // the test should fail and force an intentional design update.
        expect(badge.className).toContain('bg-[#5b21b6]')
        expect(badge.className).toContain('text-white')
    })

    it('renders the "Un" badge with secondary-bg colors for null flavor', () => {
        const { container } = render(<AgentFlavorIcon flavor={null} />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Un')
        expect(badge.className).toContain('bg-[var(--app-secondary-bg)]')
    })

    it('renders the "Un" badge for undefined flavor', () => {
        const { container } = render(<AgentFlavorIcon flavor={undefined} />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('renders the "Un" badge for empty string', () => {
        const { container } = render(<AgentFlavorIcon flavor="" />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('renders the "Un" badge for unknown flavor strings', () => {
        const { container } = render(<AgentFlavorIcon flavor="mystery-cli" />)
        const badge = getBadge(container)
        expect(badge.textContent).toBe('Un')
        expect(badge.className).toContain('bg-[var(--app-secondary-bg)]')
    })

    it('normalizes flavor case and whitespace', () => {
        // The component lowercases + trims internally so casing and surrounding
        // whitespace do not change the resolved flavor.
        for (const flavor of ['CODEX', 'Codex', '  codex  ', 'CODEX ']) {
            const { container } = render(<AgentFlavorIcon flavor={flavor} />)
            const badge = getBadge(container)
            expect(badge.querySelector('svg')).toBeTruthy()
            expect(badge.title).toBe('Codex')
        }
    })

    it('uses the monochrome OpenAI knot icon for Codex', () => {
        const { container } = render(<AgentFlavorIcon flavor="codex" />)
        const svg = container.querySelector('svg')
        expect(svg).toBeTruthy()
        expect(svg?.getAttribute('fill')).toBe('currentColor')
        expect(container.querySelector('path[fill="#fff"]')).toBeNull()
    })

    it('uses a visible orange Claude glyph for Claude sessions', () => {
        // Claude must render as a visible glyph, not the previous solid orange
        // square that hid the monochrome mark in compact picker buttons.
        const { container } = render(<AgentFlavorIcon flavor="claude" />)
        const badge = getBadge(container)
        const svg = badge.querySelector('svg')

        expect(svg).toBeTruthy()
        expect(badge.title).toBe('Claude Code')
        expect(badge.className).toContain('text-[#D97757]')
        expect(badge.className).not.toContain('bg-[#D97757]')
        expect(svg?.getAttribute('fill')).toBe('currentColor')
    })

    it('can render an online status dot attached to the icon corner', () => {
        const { container } = render(
            <AgentFlavorStatusIcon
                flavor="claude"
                showStatus
                statusClassName="bg-[#34C759]"
            />
        )
        const wrapper = container.querySelector('span.relative')
        const statusDot = container.querySelector('span.absolute')

        expect(wrapper).toBeTruthy()
        expect(statusDot).toBeTruthy()
        expect(statusDot?.className).toContain('-right-0.5')
        expect(statusDot?.className).toContain('-bottom-0.5')
        expect(statusDot?.className).toContain('bg-[#34C759]')
    })

    it('does NOT match a flavor when only whitespace is present', () => {
        // '   '.trim() === '' so the unknown branch is the only valid one.
        const { container } = render(<AgentFlavorIcon flavor="   " />)
        expect(getBadge(container).textContent).toBe('Un')
    })

    it('applies the default size classes when no className is provided', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.className).toContain('h-4')
        expect(badge.className).toContain('w-4')
    })

    it('appends the provided className alongside the badge classes', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" className="h-6 w-6" />)
        const badge = getBadge(container)
        expect(badge.className).toContain('h-6')
        expect(badge.className).toContain('w-6')
        // The default size classes must be replaced by the custom className
        // (the implementation uses `${className ?? 'h-4 w-4'}`).
        expect(badge.className).not.toContain('h-4 w-4')
    })

    it('marks the badge aria-hidden for screen readers (decorative only)', () => {
        const { container } = render(<AgentFlavorIcon flavor="pi" />)
        const badge = getBadge(container)
        expect(badge.getAttribute('aria-hidden')).toBe('true')
    })
})
