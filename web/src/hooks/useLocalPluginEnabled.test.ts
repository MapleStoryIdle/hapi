import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { getLocalPluginEnabled, useLocalPluginEnabled } from './useLocalPluginEnabled'

describe('useLocalPluginEnabled', () => {
    beforeEach(() => localStorage.clear())

    it('keeps existing features enabled by default', () => {
        expect(getLocalPluginEnabled('terminal')).toBe(true)
    })

    it('persists plugin state', () => {
        const { result } = renderHook(() => useLocalPluginEnabled('terminal'))
        act(() => result.current.setEnabled(false))
        expect(result.current.enabled).toBe(false)
        expect(getLocalPluginEnabled('terminal')).toBe(false)
    })
})
