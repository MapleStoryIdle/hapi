import { describe, expect, it, vi } from 'vitest'
import { shouldUseMobileSheet } from './useMobileSheet'

describe('shouldUseMobileSheet', () => {
    it('keeps a wide touch phone in sheet mode', () => {
        const matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia
        expect(shouldUseMobileSheet(matchMedia)).toBe(true)
        expect(matchMedia).toHaveBeenCalledWith('(min-width: 1024px), (min-width: 640px) and (hover: hover) and (pointer: fine)')
    })

    it('uses desktop dialogs only for a wide precise-pointer viewport', () => {
        const matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia
        expect(shouldUseMobileSheet(matchMedia)).toBe(false)
    })
})
