// Motion inspired by Vaul's background-scale pattern. Keep portals outside the
// transformed page and let nested sheets share a single background transform.
import { setDrawerChromeProgress } from './browser-theme-color'
type Entry = { progress: number; dragging: boolean }
const entries = new Map<symbol, Entry>()
let restoreTimer: ReturnType<typeof setTimeout> | undefined
let surface: HTMLElement | null = null

export function updateDrawerBackground(id: symbol, entry: Entry | null) {
    if (entry) entries.set(id, entry)
    else entries.delete(id)
    clearTimeout(restoreTimer)
    if (surface && !surface.isConnected) surface = null
    surface ??= document.querySelector<HTMLElement>('[data-chat-drawer-background]')
        ?? document.querySelector<HTMLElement>('[data-drawer-page-background]')
    const progress = Math.max(0, ...[...entries.values()].map((value) => value.progress))
    const dragging = [...entries.values()].some((value) => value.dragging && value.progress === progress)
    const root = document.documentElement
    root.dataset.drawerChrome = 'true'
    root.dataset.drawerChromeDragging = String(dragging)
    root.dataset.drawerChromeClosing = String(entries.size === 0)
    setDrawerChromeProgress(progress)
    if (surface) {
        surface.dataset.drawerActive = 'true'
        surface.dataset.drawerDragging = String(dragging)
        surface.dataset.drawerClosing = String(entries.size === 0)
        surface.style.setProperty('--drawer-background-progress', String(progress))
    }
    if (!entries.size) {
        const target = surface
        restoreTimer = setTimeout(() => {
            if (target) {
                delete target.dataset.drawerActive
                delete target.dataset.drawerDragging
                delete target.dataset.drawerClosing
                target.style.removeProperty('--drawer-background-progress')
            }
            delete root.dataset.drawerChrome
            delete root.dataset.drawerChromeDragging
            delete root.dataset.drawerChromeClosing
            root.style.removeProperty('--drawer-chrome-color')
            surface = null
        }, 400)
    }
}
