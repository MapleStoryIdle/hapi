import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnsiTerminalText, parseAnsiTerminalText, stripAnsiTerminalSequences } from './AnsiTerminalText'

describe('AnsiTerminalText', () => {
    it('preserves standard, bright, true-color, and reset styles', () => {
        const segments = parseAnsiTerminalText('\u001b[32mgreen\u001b[1;94m bright\u001b[38;2;12;34;56m rgb\u001b[0m plain')

        expect(segments.map((segment) => segment.text)).toEqual(['green', ' bright', ' rgb', ' plain'])
        expect(segments[0]?.style.color).toBe('var(--terminal-ansi-green)')
        expect(segments[1]?.style).toMatchObject({ color: 'var(--terminal-ansi-bright-blue)', fontWeight: 700 })
        expect(segments[2]?.style).toMatchObject({ color: 'rgb(12 34 56)', fontWeight: 700 })
        expect(segments[3]?.style.color).toBeUndefined()
    })

    it('removes cursor and OSC controls while keeping safe visible text', () => {
        const value = '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007\u001b[?25l done'
        expect(stripAnsiTerminalSequences(value)).toBe('link done')
        const view = render(<pre><AnsiTerminalText text={value} /></pre>)
        expect(view.container).toHaveTextContent('link done')
        expect(view.container.querySelector('a')).toBeNull()
    })
})
