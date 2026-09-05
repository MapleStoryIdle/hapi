// Motion inspired by Vaul's background-scale pattern. Keep portals outside the
// transformed page and let nested sheets share a single background transform.
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
    if (!surface) return
    const progress = Math.max(0, ...[...entries.values()].map((value) => value.progress))
    const dragging = [...entries.values()].some((value) => value.dragging && value.progress === progress)
    surface.dataset.drawerActive = 'true'
    surface.dataset.drawerDragging = String(dragging)
    surface.style.setProperty('--drawer-background-progress', String(progress))
    if (!entries.size) {
        const target = surface
        restoreTimer = setTimeout(() => {
            delete target.dataset.drawerActive
            delete target.dataset.drawerDragging
            target.style.removeProperty('--drawer-background-progress')
            surface = null
        }, 450)
    }
}
