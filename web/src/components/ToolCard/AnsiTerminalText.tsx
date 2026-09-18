import type { CSSProperties, ReactNode } from 'react'

type AnsiState = {
    foreground: string | null
    background: string | null
    bold: boolean
    dim: boolean
    italic: boolean
    underline: boolean
    inverse: boolean
    hidden: boolean
    strike: boolean
}

export type AnsiTerminalSegment = {
    text: string
    style: CSSProperties
}

const ANSI_SEQUENCE_PATTERN = /\u001b(?:\[([0-?]*)([ -/]*)([@-~])|\][^\u0007]*(?:\u0007|\u001b\\))/g
const DEFAULT_FOREGROUND = 'var(--terminal-text)'
const DEFAULT_BACKGROUND = 'var(--terminal-section-bg)'
const ANSI_COLORS = [
    'var(--terminal-ansi-black)', 'var(--terminal-ansi-red)', 'var(--terminal-ansi-green)', 'var(--terminal-ansi-yellow)',
    'var(--terminal-ansi-blue)', 'var(--terminal-ansi-magenta)', 'var(--terminal-ansi-cyan)', 'var(--terminal-ansi-white)',
    'var(--terminal-ansi-bright-black)', 'var(--terminal-ansi-bright-red)', 'var(--terminal-ansi-bright-green)', 'var(--terminal-ansi-bright-yellow)',
    'var(--terminal-ansi-bright-blue)', 'var(--terminal-ansi-bright-magenta)', 'var(--terminal-ansi-bright-cyan)', 'var(--terminal-ansi-bright-white)'
] as const

function initialState(): AnsiState {
    return {
        foreground: null,
        background: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        hidden: false,
        strike: false
    }
}

function clampByte(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)))
}

function color256(index: number): string | null {
    if (!Number.isInteger(index) || index < 0 || index > 255) return null
    if (index < 16) return ANSI_COLORS[index] ?? null
    if (index >= 232) {
        const gray = 8 + (index - 232) * 10
        return `rgb(${gray} ${gray} ${gray})`
    }
    const value = index - 16
    const red = Math.floor(value / 36)
    const green = Math.floor(value % 36 / 6)
    const blue = value % 6
    const channel = (part: number) => part === 0 ? 0 : 55 + part * 40
    return `rgb(${channel(red)} ${channel(green)} ${channel(blue)})`
}

function applySgr(state: AnsiState, rawParameters: string): void {
    const parameters = rawParameters.replaceAll(':', ';')
    const codes = parameters.length === 0
        ? [0]
        : parameters.split(';').map((value) => Number.parseInt(value || '0', 10))

    for (let index = 0; index < codes.length; index += 1) {
        const code = codes[index]
        if (!Number.isFinite(code)) continue
        if (code === 0) Object.assign(state, initialState())
        else if (code === 1) state.bold = true
        else if (code === 2) state.dim = true
        else if (code === 3) state.italic = true
        else if (code === 4) state.underline = true
        else if (code === 7) state.inverse = true
        else if (code === 8) state.hidden = true
        else if (code === 9) state.strike = true
        else if (code === 21) state.bold = false
        else if (code === 22) { state.bold = false; state.dim = false }
        else if (code === 23) state.italic = false
        else if (code === 24) state.underline = false
        else if (code === 27) state.inverse = false
        else if (code === 28) state.hidden = false
        else if (code === 29) state.strike = false
        else if (code >= 30 && code <= 37) state.foreground = ANSI_COLORS[code - 30] ?? null
        else if (code === 39) state.foreground = null
        else if (code >= 40 && code <= 47) state.background = ANSI_COLORS[code - 40] ?? null
        else if (code === 49) state.background = null
        else if (code >= 90 && code <= 97) state.foreground = ANSI_COLORS[code - 90 + 8] ?? null
        else if (code >= 100 && code <= 107) state.background = ANSI_COLORS[code - 100 + 8] ?? null
        else if (code === 38 || code === 48) {
            const target = code === 38 ? 'foreground' : 'background'
            const mode = codes[index + 1]
            if (mode === 5 && Number.isFinite(codes[index + 2])) {
                state[target] = color256(codes[index + 2]!)
                index += 2
            } else if (mode === 2 && codes.slice(index + 2, index + 5).every(Number.isFinite)) {
                state[target] = `rgb(${clampByte(codes[index + 2]!)} ${clampByte(codes[index + 3]!)} ${clampByte(codes[index + 4]!)})`
                index += 4
            }
        }
    }
}

function styleForState(state: AnsiState): CSSProperties {
    const decorations = [state.underline ? 'underline' : '', state.strike ? 'line-through' : ''].filter(Boolean).join(' ')
    const foreground = state.inverse ? state.background ?? DEFAULT_BACKGROUND : state.foreground
    const background = state.inverse ? state.foreground ?? DEFAULT_FOREGROUND : state.background
    return {
        color: foreground ?? undefined,
        backgroundColor: background ?? undefined,
        fontWeight: state.bold ? 700 : undefined,
        fontStyle: state.italic ? 'italic' : undefined,
        opacity: state.dim ? 0.72 : undefined,
        textDecoration: decorations || undefined,
        visibility: state.hidden ? 'hidden' : undefined
    }
}

export function parseAnsiTerminalText(value: string): AnsiTerminalSegment[] {
    const segments: AnsiTerminalSegment[] = []
    const state = initialState()
    let cursor = 0

    for (const match of value.matchAll(ANSI_SEQUENCE_PATTERN)) {
        const index = match.index ?? 0
        if (index > cursor) segments.push({ text: value.slice(cursor, index), style: styleForState(state) })
        if (match[3] === 'm' && !match[2]) applySgr(state, match[1] ?? '')
        cursor = index + match[0].length
    }
    if (cursor < value.length) segments.push({ text: value.slice(cursor), style: styleForState(state) })
    return segments
}

export function stripAnsiTerminalSequences(value: string): string {
    return value.replace(ANSI_SEQUENCE_PATTERN, '')
}

export function AnsiTerminalText(props: { text: string }): ReactNode {
    const segments = parseAnsiTerminalText(props.text)
    return segments.map((segment, index) => (
        <span key={`${index}:${segment.text.length}`} style={segment.style}>{segment.text}</span>
    ))
}
