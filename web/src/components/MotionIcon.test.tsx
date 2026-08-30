import { Folder } from 'lucide'
import { describe, expect, it } from 'vitest'
import { toMotionIcon } from './MotionIcon'

describe('toMotionIcon', () => {
    it('adapts and caches HAPI’s aligned Lucide SVG tuple', () => {
        const input = toMotionIcon(Folder)

        expect(input).toBe(toMotionIcon(Folder))
        expect(Array.isArray(input)).toBe(true)
        if (!Array.isArray(input)) throw new Error('Expected a path list')
        expect(input[0]).toEqual([
            'path',
            expect.objectContaining({ d: expect.any(String) })
        ])
    })
})
