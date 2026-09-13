import { describe, expect, it } from 'vitest'
import { getSessionLabelColor, getSessionLabelUnits } from './session-labels'

describe('session labels', () => {
    it('uses weighted compact limits', () => {
        expect(getSessionLabelUnits('12345678')).toBe(8)
        expect(getSessionLabelUnits('一二三四')).toBe(8)
        expect(getSessionLabelUnits('前端-ready')).toBe(10)
    })

    it('assigns stable independent colors from normalized label text', () => {
        expect(getSessionLabelColor('Review')).toBe(getSessionLabelColor(' review '))
        expect(new Set(['Review', 'Frontend', 'Urgent', 'Backend'].map(getSessionLabelColor)).size).toBeGreaterThan(1)
    })
})
