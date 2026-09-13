import type { CSSProperties } from 'react'

const LABEL_COLORS = [
    '#007AFF', '#5856D6', '#AF52DE', '#D12F6A',
    '#C93400', '#A05A00', '#248A3D', '#087E8B'
] as const

export function getSessionLabelUnits(value: string): number {
    return Array.from(value).reduce((total, character) => (
        total + (/\p{Script=Han}/u.test(character) ? 2 : 1)
    ), 0)
}

export function getSessionLabelColor(label: string): string {
    let hash = 2166136261
    for (const character of label.trim().toLocaleLowerCase()) {
        hash ^= character.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
    }
    return LABEL_COLORS[(hash >>> 0) % LABEL_COLORS.length]
}

export function getSessionLabelStyle(label: string): CSSProperties {
    const color = getSessionLabelColor(label)
    return {
        color,
        backgroundColor: `color-mix(in srgb, ${color} 11%, var(--app-bg))`,
        borderColor: `color-mix(in srgb, ${color} 24%, transparent)`
    }
}
