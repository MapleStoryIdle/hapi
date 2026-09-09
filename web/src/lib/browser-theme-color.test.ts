import { afterEach, expect, it, vi } from 'vitest'
import { drawerChromeColor, setBrowserThemeColor, setDrawerChromeProgress } from './browser-theme-color'
import { updateDrawerBackground } from './drawer-background'

afterEach(() => {
    setDrawerChromeProgress(0)
    document.documentElement.removeAttribute('data-theme')
    vi.useRealTimers()
})

it('blends the current theme with the same light/dark sheet scrim', () => {
    expect(drawerChromeColor('#ffffff', 1, false)).toBe('#a4a7ae')
    expect(drawerChromeColor('#1c1c1e', 1, true)).toBe('#0c0c0d')
    expect(drawerChromeColor('#000000', 1, true)).toBe('#000000')
    expect(drawerChromeColor('#ffffff', 0, false)).toBe('#ffffff')
})

it('restores the latest theme instead of an old color captured at opening', () => {
    setBrowserThemeColor('#ffffff')
    setDrawerChromeProgress(1)
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#a4a7ae')
    document.documentElement.dataset.theme = 'dark'
    setBrowserThemeColor('#1c1c1e')
    setDrawerChromeProgress(0)
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#1c1c1e')
})

it('keeps the tint for nested drawers and removes it after the last exit', () => {
    vi.useFakeTimers()
    setBrowserThemeColor('#ffffff')
    const outer = Symbol('outer'), inner = Symbol('inner')
    updateDrawerBackground(outer, { progress: 1, dragging: false })
    updateDrawerBackground(inner, { progress: 1, dragging: false })
    updateDrawerBackground(inner, null)
    vi.advanceTimersByTime(500)
    expect(document.documentElement.dataset.drawerChrome).toBe('true')
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#a4a7ae')
    updateDrawerBackground(outer, null)
    expect(document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe('#ffffff')
    expect(document.documentElement.dataset.drawerChromeClosing).toBe('true')
    vi.advanceTimersByTime(399)
    expect(document.documentElement.dataset.drawerChrome).toBe('true')
    vi.advanceTimersByTime(1)
    expect(document.documentElement.dataset.drawerChrome).toBeUndefined()
    expect(document.documentElement.dataset.drawerChromeClosing).toBeUndefined()
})
