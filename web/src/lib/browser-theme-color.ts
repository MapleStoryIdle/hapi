let baseColor = '#ffffff'
let drawerProgress = 0

/** Match the sheet scrim without changing the user's saved appearance. */
export function drawerChromeColor(base: string, progress: number, dark: boolean): string {
    if (!/^#[\da-f]{6}$/i.test(base)) return base
    const tint = dark ? [0, 0, 0] : [15, 23, 42]
    const alpha = Math.min(1, Math.max(0, progress)) * (dark ? 0.56 : 0.38)
    return '#' + tint.map((channel, index) => {
        const original = parseInt(base.slice(1 + index * 2, 3 + index * 2), 16)
        return Math.round(original * (1 - alpha) + channel * alpha).toString(16).padStart(2, '0')
    }).join('')
}

function renderThemeColor() {
    const root = document.documentElement
    const color = drawerChromeColor(baseColor, drawerProgress, ['dark', 'oled'].includes(root.dataset.theme ?? 'light'))
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'theme-color'
        document.head.appendChild(meta)
    }
    meta.content = color
    meta.removeAttribute('media')
    root.style.setProperty('--drawer-chrome-color', color)
}

export function setBrowserThemeColor(color: string) {
    baseColor = color
    renderThemeColor()
}

export function setDrawerChromeProgress(progress: number) {
    drawerProgress = Math.min(1, Math.max(0, progress))
    renderThemeColor()
}
