import { expect, test, devices, type Page } from '@playwright/test'
import { localServiceUnavailable } from '../hub/src/localServices/unavailable'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })
const fixture = '/e2e-fixtures/chat-drawer-fixture.html'

test('terminal input and output share a compact reading surface', async ({ page }, info) => {
    await page.goto(fixture + '?long-command')
    await page.getByRole('button', { name: 'Terminal detail', exact: true }).tap()
    const drawer = page.getByTestId('terminal-execution-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    await expect(drawer.getByRole('tab')).toHaveCount(0)
    const titleRow = await drawer.getByRole('heading').first().boundingBox()
    const directoryRow = await drawer.locator('[data-terminal-directory]').boundingBox()
    const statusRow = await drawer.locator('[data-terminal-status]').boundingBox()
    expect(directoryRow!.y).toBeGreaterThanOrEqual(titleRow!.y + titleRow!.height)
    expect(statusRow!.y).toBeGreaterThanOrEqual(directoryRow!.y + directoryRow!.height)
    expect(Math.abs(titleRow!.x - directoryRow!.x)).toBeLessThan(1)
    const durationRow = await drawer.locator('[data-terminal-duration]').boundingBox()
    expect(Math.abs(titleRow!.x - durationRow!.x)).toBeLessThan(1)
    const icons = drawer.locator('[data-terminal-header-icon]')
    await expect(icons).toHaveCount(3)
    const iconBounds = await icons.evaluateAll(elements => elements.map(el => {
        const { x, width, height } = el.getBoundingClientRect()
        return { x, width, height }
    }))
    for (const icon of iconBounds) {
        expect(icon.x).toBe(iconBounds[0].x)
        expect(icon.width).toBe(20)
        expect(icon.height).toBe(20)
    }
    await expect(drawer.locator('[data-terminal-status]')).toHaveText('2.3s')
    await expect(drawer.getByRole('img', { name: 'Completed' })).toBeVisible()
    const surface = drawer.locator('.terminal-transcript-surface')
    await expect(surface).toHaveCount(1)
    await expect(surface.locator(':scope > .terminal-transcript-section')).toHaveCount(2)
    const command = surface.locator('[data-terminal-execution-input] pre')
    const output = surface.locator('[data-terminal-execution-output] pre')
    for (const code of [command, output]) {
        await expect(code).toHaveCSS('font-size', '13px')
        await expect(code).toHaveCSS('line-height', '20px')
        await expect(code).toHaveCSS('white-space', 'pre')
    }
    expect(await command.evaluate(el => getComputedStyle(el).color)).toBe(await output.evaluate(el => getComputedStyle(el).color))
    const labels = surface.locator('.terminal-transcript-label')
    expect(await labels.nth(0).evaluate(el => getComputedStyle(el).color)).toBe(await labels.nth(1).evaluate(el => getComputedStyle(el).color))
    await expect(surface.locator('[data-terminal-execution-output]')).toHaveCSS('border-top-width', '1px')
    await drawer.getByRole('button', { name: 'Wrap lines' }).tap()
    for (const code of [command, output]) await expect(code).toHaveCSS('white-space', 'pre-wrap')
    await expect(surface.locator('[data-terminal-execution-input]').getByRole('button', { name: 'Copy command' })).toBeInViewport()
    await expect(surface.locator('[data-terminal-execution-output]').getByRole('button', { name: 'Copy output' })).toBeVisible()
    const viewport = await page.evaluate(() => window.visualViewport!.height)
    expect((await drawer.boundingBox())!.height).toBeLessThanOrEqual(viewport * .7 + 1)
    await page.screenshot({ path: info.outputPath('terminal-unified-mobile.png') })
})

for (const language of ['zh-CN', 'en']) {
    test(`unreachable local service stays in the drawer and retries in place (${language})`, async ({ page, context }, info) => {
        const zh = language === 'zh-CN'
        await page.addInitScript((locale) => localStorage.setItem('hapi-lang', locale), language)
        let attempts = 0
        await page.route('**/__shapi_local/embed/**', async (route) => {
            attempts++
            if (attempts > 1) {
                await route.fulfill({ contentType: 'text/html', body: '<h1>Local service restored</h1>' })
                return
            }
            const response = localServiceUnavailable(new Request(route.request().url(), { headers: {
                'sec-fetch-dest': 'iframe', 'accept-language': language
            } }), [new URL(page.url()).origin])
            await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
        })
        await page.goto(fixture)
        await page.waitForLoadState('networkidle')
        const originalUrl = page.url()
        await page.getByRole('button', { name: 'Local service preview', exact: true }).tap()
        const drawer = page.getByTestId('chat-preview-drawer')
        const frame = drawer.frameLocator('iframe')
        await expect(frame.getByRole('alert')).toHaveText(zh ? '无法连接服务器' : 'Unable to connect to the server')
        await expect(drawer.getByRole('button', { name: zh ? '复制链接' : 'Copy link' })).toBeInViewport()
        await expect(drawer.getByRole('link')).toHaveCount(0)
        await expect(frame.getByRole('link')).toHaveCount(0)
        const retry = frame.getByRole('button', { name: zh ? '重新连接' : 'Try again' })
        await expect(retry).toBeInViewport()
        expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        expect(attempts).toBe(1)
        if (zh) await page.screenshot({ path: info.outputPath('local-service-unavailable-zh.png') })
        await retry.tap()
        await expect(frame.getByRole('heading', { name: 'Local service restored' })).toBeVisible()
        expect(attempts).toBe(2)
        expect(page.url()).toBe(originalUrl)
        expect(context.pages()).toHaveLength(1)
    })
}

async function dragHandle(page: Page, distance: number) {
    const handle = page.locator('[data-question-drawer-handle]').last()
    const bounds = await handle.boundingBox()
    if (!bounds) throw new Error('Drawer handle missing')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 10 + distance, { steps: 8 })
    // A short settled drag tests distance/rebound, not the flick velocity path.
    await page.waitForTimeout(120)
    await page.mouse.up()
}

test('content-sized sheet caps at 70%, scrolls inside, dismisses and restores layout', async ({ page }, info) => {
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    const composer = page.getByTestId('composer')
    const before = await composer.boundingBox()
    await page.getByRole('button', { name: 'Short detail', exact: true }).tap()
    const short = page.getByRole('dialog', { name: 'Short detail' })
    await expect(short).toBeVisible()
    await expect(short).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    const small = await short.boundingBox()
    expect(small!.height).toBeLessThan(300)
    await expect(page.locator('[data-chat-drawer-background]')).not.toHaveCSS('transform', 'none')
    await dragHandle(page, 20)
    await expect(short).toBeVisible()
    await expect(short).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    await dragHandle(page, 150)
    await expect(short).toBeHidden()
    await expect(page.locator('[data-chat-drawer-background]')).toHaveCSS('transform', 'none')
    expect(await composer.boundingBox()).toEqual(before)

    await page.getByRole('button', { name: 'Long detail', exact: true }).tap()
    const long = page.getByRole('dialog', { name: 'Long detail' })
    await expect(long).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    const bounds = await long.boundingBox()
    const visibleHeight = await page.evaluate(() => window.visualViewport!.height)
    expect(bounds!.height).toBeLessThanOrEqual(visibleHeight * .7 + 1)
    expect(bounds!.height).toBeGreaterThan(small!.height)
    const body = long.locator('[data-chat-drawer-body]')
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(long.getByText('Log line 100: completed successfully.')).toBeInViewport()
    await page.screenshot({ path: info.outputPath('mobile-chat-drawer.png') })
    await page.mouse.click(12, 80)
    await expect(long).toBeHidden()
})

test('terminal metadata, file target line and sandboxed URL preview remain usable', async ({ page }) => {
    await page.route('https://example.com/', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>External content</h1>' }))
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Terminal detail' }).tap()
    const terminal = page.getByTestId('terminal-execution-drawer')
    await expect(terminal).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    expect((await terminal.boundingBox())!.height).toBeLessThanOrEqual(844 * .7 + 1)
    await expect(terminal.getByText('/workspace/hapi', { exact: true })).toBeVisible()
    await terminal.getByRole('button', { name: 'Close' }).tap()
    await expect(terminal).toBeHidden()
    await page.getByRole('button', { name: 'File preview', exact: true }).tap()
    const preview = page.getByTestId('chat-preview-drawer')
    await expect(preview.getByText('const line80 = "hello"', { exact: false })).toBeInViewport()
    await preview.getByRole('button', { name: 'Close' }).tap()
    await expect(preview).toBeHidden()
    await page.getByRole('button', { name: 'Web preview', exact: true }).tap()
    await expect(preview.locator('iframe')).toBeVisible()
    await expect(preview.locator('iframe')).not.toHaveAttribute('sandbox', /allow-same-origin|allow-top-navigation/)
    await expect(preview.getByRole('button', { name: 'Copy link' })).toBeInViewport()
    await expect(preview.getByRole('link', { name: 'Open in browser' })).toHaveCount(0)
    await expect(preview.getByText(/Some sites do not allow/)).toHaveCount(0)
    expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(844 * .7 + 1)
})

test('content links open in the shared drawer without leaving the conversation', async ({ page }) => {
    await page.goto(fixture)
    const originalUrl = page.url()
    await page.getByRole('link', { name: 'Content web link' }).tap()
    const drawer = page.getByTestId('chat-preview-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('iframe')).toHaveAttribute('src', /\/content\/article$/)
    expect(page.url()).toBe(originalUrl)
})

test('question close preserves choices and busy submission cannot dismiss', async ({ page }) => {
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Choose options' }).tap()
    const question = page.getByTestId('question-answer-form-drawer')
    await question.getByRole('checkbox', { name: /Blue/ }).tap()
    await question.getByRole('button', { name: 'Close' }).tap()
    await expect(question).toBeHidden()
    await expect(page.getByTestId('sent-count')).toHaveText('0')
    await page.getByRole('button', { name: /Answer question/i }).tap()
    await expect(question.getByRole('checkbox', { name: /Blue/ })).toHaveAttribute('aria-checked', 'true')
    await question.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(question.getByRole('button', { name: 'Close' })).toBeDisabled()
    await page.mouse.click(12, 70)
    await expect(page.getByTestId('sent-count')).toHaveText('1')
    await expect(question).toBeHidden()
})

test('reduced motion and keyboard-sized viewport keep details reachable', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 390, height: 380 })
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Long detail', exact: true }).tap()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toHaveCSS('animation-name', 'none')
    await expect(page.locator('[data-chat-drawer-background]')).toHaveCSS('transform', 'none')
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(380 * .7 + 1)
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeInViewport()
})

test('desktop keeps centered details and no background recession', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Short detail', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const box = (await dialog.boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(2)
    expect(Math.abs(box.y + box.height / 2 - 400)).toBeLessThan(2)
    await expect(page.locator('[data-chat-drawer-background]')).toHaveCSS('transform', 'none')
})

test('local service opens directly and copies its reconnectable link without opening a new page', async ({ page, context }, info) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem('copied-preview-link', text) } }
        })
    })
    await page.route('**/__shapi_local/embed/**', (route) => {
        const url = new URL(route.request().url())
        if (url.pathname.endsWith('/favicon.svg')) return route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#2574dd"/></svg>'
        })
        const icon = new URL('./favicon.svg', url).href
        return route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><title>My local website</title><h1>My local website</h1><p>Running on the conversation computer.</p>'
                + '<p>Scrollable local content</p>'.repeat(70)
                + `<script>parent.postMessage({type:'shapi:preview-metadata',title:document.title,icon:${JSON.stringify(icon)}},${JSON.stringify(url.origin)})</script>`
        })
    })
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    const pages = context.pages().length
    await page.getByRole('button', { name: 'Local service preview', exact: true }).tap()
    const drawer = page.getByTestId('chat-preview-drawer')
    await expect(drawer.frameLocator('iframe').getByRole('heading', { name: 'My local website' })).toBeVisible()
    await expect(drawer.getByRole('heading', { name: 'My local website' })).toBeVisible()
    await expect(drawer.locator('img')).toBeVisible()
    await expect.poll(() => drawer.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await expect(drawer.getByText(/网站功能受预览限制/)).toHaveCount(0)
    await expect(drawer.getByRole('link', { name: '在浏览器打开' })).toHaveCount(0)
    const copy = drawer.getByRole('button', { name: '复制链接' })
    await expect(copy).toHaveText('')
    await expect(copy.locator('svg')).toBeVisible()
    await expect(copy).toBeInViewport()
    expect((await copy.boundingBox())!.width).toBeGreaterThanOrEqual(44)
    expect((await copy.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await copy.tap()
    const copied = new URL((await page.evaluate(() => sessionStorage.getItem('copied-preview-link')))!)
    expect(copied.origin).toBe(new URL(page.url()).origin)
    expect(copied.pathname).toBe('/local-service')
    const params = new URLSearchParams(copied.hash.slice(1))
    expect(params.get('url')).toBe('http://localhost:3000/')
    expect(JSON.parse(params.get('source')!)).toEqual({ type: 'session', sessionId: 'fixture' })
    expect(copied.pathname).not.toContain('/embed/')
    expect(context.pages()).toHaveLength(pages)
    expect(page.url()).toContain(fixture)
    const height = await page.evaluate(() => window.visualViewport!.height)
    expect((await drawer.boundingBox())!.height).toBeLessThanOrEqual(height * .7 + 1)
    await expect(drawer.getByRole('button', { name: '关闭' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('local-web-preview-copy-zh.png') })
    const frame = await drawer.locator('iframe').elementHandle().then((element) => element!.contentFrame())
    const longTitle = 'OpenViking Studio — 项目知识库和本地文件管理 '.repeat(3)
    await frame!.evaluate(({ title, origin }) => parent.postMessage({ type: 'shapi:preview-metadata', title }, origin), {
        title: longTitle, origin: new URL(page.url()).origin
    })
    await expect(drawer.getByRole('heading', { name: longTitle.trim() })).toHaveCSS('text-overflow', 'ellipsis')
    expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(copy).toBeInViewport()
    await expect(drawer.getByRole('button', { name: '关闭' })).toBeInViewport()
    await drawer.getByRole('button', { name: '关闭' }).tap()
    await expect(drawer).toBeHidden()
})

test('pending question options stay readable and selected controls stand out in both themes', async ({ page }, info) => {
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Choose options' }).tap()
    const question = page.getByTestId('question-answer-form-drawer')
    await expect(question).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    const blue = question.getByRole('checkbox', { name: /Blue/ })
    const green = question.getByRole('checkbox', { name: /Green/ })
    for (const theme of ['light', 'dark', 'oled']) {
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
        await expect(green).toBeEnabled()
        await expect(green.locator(':scope > span')).toHaveCSS('opacity', '1')
        // Wait for theme color transitions before checking contrast or capturing.
        await expect(green).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 255, 255)' : theme === 'dark' ? 'rgb(44, 44, 46)' : 'rgb(28, 28, 30)')
        await expect(green.locator(':scope > span')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
        const foreground = await question.evaluate((el) => getComputedStyle(el).color)
        await expect(green.getByText('Green', { exact: true })).toHaveCSS('color', foreground)
        if (theme === 'light') await blue.tap()
        await expect(blue).toHaveAttribute('aria-checked', 'true')
        await expect(blue.locator('[aria-hidden]')).not.toHaveCSS('background-color', await green.locator('[aria-hidden]').evaluate((el) => getComputedStyle(el).backgroundColor))
        const contrast = await green.evaluate((element) => {
            const luminance = (color: string) => {
                const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
                    const channel = value / 255
                    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4
                })
                return values[0] * .2126 + values[1] * .7152 + values[2] * .0722
            }
            const ratio = (a: string, b: string) => {
                const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
                return (values[0] + .05) / (values[1] + .05)
            }
            const background = getComputedStyle(element).backgroundColor
            return {
                text: ratio(getComputedStyle(element.querySelector('.chat-option-description')!).color, background),
                control: ratio(getComputedStyle(element.querySelector('[aria-hidden]')!).borderColor, background)
            }
        })
        expect(contrast.text).toBeGreaterThanOrEqual(4.5)
        expect(contrast.control).toBeGreaterThanOrEqual(3)
        await page.screenshot({ path: info.outputPath(`question-options-${theme}.png`) })
    }
})

test('subagent details use the shared sheet with activity first and information second', async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: /Drawer review/ }).tap()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toHaveAttribute('data-chat-detail-drawer', 'true')
    await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    const tabs = drawer.getByRole('tab')
    await expect(tabs).toHaveText(['Activity', 'Information'])
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')
    await expect(drawer.getByText('Checking mobile drawer interactions')).toBeVisible()
    await expect(drawer.getByText('review-agent-identifier', { exact: true })).toHaveCount(0)
    const height = await page.evaluate(() => visualViewport!.height)
    expect((await drawer.boundingBox())!.height).toBeLessThanOrEqual(height * .7 + 1)
    await expect(drawer.locator('.chat-trace-label').first()).toHaveCSS('white-space', 'nowrap')
    expect((await tabs.first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: info.outputPath('subagent-activity.png') })
    await drawer.getByRole('button', { name: /Review step 1:/ }).click()
    await expect(drawer.getByText('Review step 1: checked keyboard focus and scrolling. No layout shift found.', { exact: true }).last()).toBeVisible()
    const body = drawer.locator('[data-chat-drawer-body]')
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(drawer.getByText('Review step 18:', { exact: false })).toBeInViewport()
    await expect(tabs.last()).toBeInViewport()
    await tabs.last().tap()
    await expect(drawer.getByText('test-model', { exact: true })).toBeVisible()
    await expect(drawer.getByText('review-agent-identifier', { exact: true })).toBeVisible()
    const mutedColor = await drawer.locator('dt').first().evaluate((el) => getComputedStyle(el).color)
    await expect(tabs.first()).toHaveCSS('color', mutedColor)
    await page.screenshot({ path: info.outputPath('subagent-information.png') })
    await drawer.getByRole('button', { name: 'Close' }).tap()
    await expect(drawer).toBeHidden()
    await page.getByRole('button', { name: /Drawer review/ }).tap()
    await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true')
    await dragHandle(page, 200)
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(errors).toEqual([])
})

for (const desktop of [false, true]) {
    test(`nested URI and file sheets stack above their parent and restore focus (${desktop ? 'desktop' : 'mobile'})`, async ({ page }, info) => {
        if (desktop) await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(fixture)
    await page.waitForLoadState('networkidle')
        // Historical answers deliberately stay bottom sheets on desktop, too.
        await page.getByTestId('question-answer-toggle').click()
        const parent = page.getByTestId('question-answer-details-drawer')
        await expect(parent).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
        const link = parent.getByRole('link', { name: 'Open note' })
        await link.focus()
        await link.click()
        const child = page.getByTestId('uri-confirm-drawer')
        await expect(child).toBeVisible()
        const parentZ = await parent.evaluate((el) => Number(getComputedStyle(el).zIndex))
        const childZ = await child.evaluate((el) => Number(getComputedStyle(el).zIndex))
        expect(childZ).toBeGreaterThan(parentZ + 1)
        const scrim = page.locator('.chat-overlay-scrim').last()
        expect(await scrim.evaluate((el) => Number(getComputedStyle(el).zIndex))).toBeGreaterThan(parentZ)
        for (const button of await child.getByRole('button').all()) {
            expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44)
        }
        if (!desktop) {
            await expect(child).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
            await page.screenshot({ path: info.outputPath('nested-uri-ios.png') })
        }
        await page.keyboard.press('Escape')
        await expect(child).toBeHidden()
        await expect(parent).toBeVisible()
        await expect(link).toBeFocused()
        await link.click()
        await expect(child).toBeVisible()
        // Radix registers outside-pointer dismissal on the next task after mount.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        await page.mouse.click(8, 40)
        await expect(child).toBeHidden()
        await expect(parent).toBeVisible()
        await parent.getByRole('button', { name: 'Close' }).click()
        await expect(parent).toBeHidden()

        await page.getByRole('button', { name: 'Linked details', exact: true }).click()
        const linked = page.getByTestId('linked-details-drawer')
        const fileButton = linked.getByRole('button', { name: 'Nested file' })
        if (desktop) return // ChatPreview interception intentionally mobile only.
        await fileButton.focus()
        await fileButton.click()
        const file = page.getByTestId('chat-preview-drawer')
        await expect(file).toBeVisible()
        expect(await file.evaluate((el) => Number(getComputedStyle(el).zIndex)))
            .toBeGreaterThan(await linked.evaluate((el) => Number(getComputedStyle(el).zIndex)) + 1)
        await page.keyboard.press('Escape')
        await expect(file).toBeHidden()
        await expect(fileButton).toBeFocused()
        await expect(page.locator('[data-chat-drawer-background]')).not.toHaveCSS('transform', 'none')
    })
}

test('desktop long details scroll inside; enlarged text and landscape retain close controls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Long detail', exact: true }).click()
    const dialog = page.getByRole('dialog')
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(752)
    const body = dialog.locator('[data-chat-drawer-body]')
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(dialog.getByText('Log line 100: completed successfully.')).toBeInViewport()
    await dialog.getByRole('button', { name: 'Close' }).click()

    await page.setViewportSize({ width: 375, height: 812 })
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%' })
    await page.getByRole('button', { name: 'Short detail', exact: true }).click()
    await expect(dialog).toHaveAccessibleDescription('A little more detail')
    await expect(dialog.getByText('Just one line.')).toBeInViewport()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeInViewport()
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: 'Close' }).click()
    await page.evaluate(() => { document.documentElement.style.fontSize = '' })
    await page.setViewportSize({ width: 844, height: 390 })
    await page.getByRole('button', { name: 'Long detail', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeInViewport()
    expect((await dialog.boundingBox())!.height).toBeLessThanOrEqual(342)
    await dialog.getByRole('button', { name: 'Close' }).click()
    // Chromium has no notch; inject canonical insets to cover landscape layout.
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--app-safe-area-left', '47px')
        document.documentElement.style.setProperty('--app-safe-area-right', '30px')
    })
    await page.route('https://example.com/', (route) => route.fulfill({ contentType: 'text/html', body: 'Preview' }))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Web preview', exact: true }).click()
    await expect(page.getByTestId('chat-preview-drawer')).toBeVisible()
    await page.setViewportSize({ width: 844, height: 390 })
    const landscape = page.getByTestId('chat-preview-drawer')
    const bounds = (await landscape.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(47 + 12)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(844 - 30 - 12)
    await expect(landscape.getByRole('button', { name: 'Close' })).toBeInViewport()
})

test('media viewer retains full-screen zoom and accessible circular controls', async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByTitle('Open image viewer').click()
    const viewer = page.locator('.chat-media-viewer')
    await expect(viewer).toBeVisible()
    const close = viewer.getByRole('button', { name: 'Close image viewer' })
    await expect(close).toBeInViewport()
    expect((await close.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    await expect(viewer.getByRole('button', { name: 'Zoom in' })).toBeVisible()
    await page.screenshot({ path: info.outputPath('image-viewer-ios.png') })
    await close.click()
    await expect(viewer).toBeHidden()
})

test('long edit has one vertical scroller and desktop terminal shares one inset', async ({ page }, info) => {
    await page.goto(fixture)
    await page.waitForLoadState('networkidle')
    await page.getByRole('button', { name: 'Long edit', exact: true }).click()
    const edit = page.getByRole('dialog', { name: 'Long edit' })
    const body = edit.locator('[data-chat-drawer-body]')
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    expect(await body.evaluate((el) => [...el.querySelectorAll('*')].filter((child) =>
        ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1
    ).length)).toBe(0)
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(edit.getByText('updated line 200', { exact: true })).toBeInViewport()
    await edit.getByRole('button', { name: 'Close' }).click()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByRole('button', { name: 'Terminal detail' }).click()
    const terminal = page.getByTestId('terminal-execution-drawer')
    const header = await terminal.locator('header').boundingBox()
    const content = await terminal.locator('[data-chat-drawer-body]').boundingBox()
    expect(Math.abs(content!.x - header!.x)).toBeLessThan(1)
    await page.screenshot({ path: info.outputPath('terminal-desktop-ios.png') })
})


test('compact terminal combines command/output, preserves reading position and supports wrapping', async ({ page }, info) => {
    await page.goto(`${fixture}?long-command`)
    await page.getByRole('button', { name: 'Terminal detail' }).tap()
    const drawer = page.getByTestId('terminal-execution-drawer')
    await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    await expect(drawer.getByRole('tab')).toHaveCount(0)
    const command = drawer.locator('[data-terminal-execution-input] pre')
    await expect(command).toBeInViewport()
    const commandPanel = drawer.locator('[data-terminal-execution-input]')
    const outputPanel = drawer.locator('[data-terminal-execution-output]')
    const assertCommandStyle = async () => {
        expect(await commandPanel.evaluate((el) => getComputedStyle(el).backgroundColor))
            .toBe(await outputPanel.evaluate((el) => getComputedStyle(el).backgroundColor))
        await expect(commandPanel).toHaveCSS('border-inline-start-width', '0px')
        await expect(outputPanel).toHaveCSS('border-top-width', '1px')
        await expect(command.locator('code')).toHaveCSS('font-family', /monospace/)
        expect(await command.locator('code').textContent()).toMatch(/^cat \/workspace\//)
        await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
    }
    await assertCommandStyle()
    await expect(drawer.locator('[data-terminal-execution-output]')).toBeVisible()
    expect(await command.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await drawer.getByRole('button', { name: 'Wrap lines' }).tap()
    await expect(command).toHaveCSS('white-space', 'pre-wrap')
    expect(await command.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await drawer.getByRole('button', { name: 'Wrap lines' }).tap()
    const body = drawer.locator('[data-chat-drawer-body]')
    expect(await body.evaluate((el) => [...el.querySelectorAll('*')].filter((child) =>
        ['auto', 'scroll'].includes(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight + 1
    ).length)).toBe(0)
    await body.evaluate((el) => { el.scrollTop = 200; el.dispatchEvent(new Event('scroll')) })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-terminal-lines', { detail: 120 })))
    await expect(drawer.locator('[data-terminal-execution-output]')).toContainText('Test 120 passed')
    await expect(body).toHaveJSProperty('scrollTop', 200)
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-terminal-lines', { detail: 140 })))
    await expect.poll(() => body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(32)
    await expect(drawer.getByText('/workspace/hapi', { exact: true })).toBeVisible()
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(200)
    await body.evaluate((el) => { el.scrollTop = 0 })
    await page.screenshot({ path: info.outputPath('terminal-compact-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await assertCommandStyle()
    await page.screenshot({ path: info.outputPath('terminal-compact-dark.png') })
    expect((await drawer.boundingBox())!.height).toBeLessThanOrEqual(844 * .7 + 1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
})

test('compact terminal remains readable with Chinese labels', async ({ page }, info) => {
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'zh-CN'))
    await page.goto(fixture)
    await page.getByRole('button', { name: 'Terminal detail' }).tap()
    const drawer = page.getByTestId('terminal-execution-drawer')
    await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    await expect(drawer.getByRole('tab')).toHaveCount(0)
    await expect(drawer.locator('[data-terminal-execution-input]')).toHaveText(/bun run test:web/)
    const copyOutput = drawer.locator('[data-terminal-execution-output]').getByRole('button', { name: '复制输出' })
    await expect(copyOutput).toBeInViewport()
    for (const name of ['自动换行', '复制命令', '复制输出']) {
        const button = drawer.getByRole('button', { name })
        await expect(button).toHaveText('')
        await expect(button.locator('svg')).toBeVisible()
        const bounds = await button.boundingBox()
        expect(bounds!.width).toBeGreaterThanOrEqual(44)
        expect(bounds!.height).toBeGreaterThanOrEqual(44)
    }
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
    await page.screenshot({ path: info.outputPath('terminal-compact-zh.png') })
    await expect(drawer.getByText('/workspace/hapi', { exact: true })).toBeInViewport()
    const copyDirectory = drawer.getByRole('button', { name: '复制目录' })
    await expect(copyDirectory).toHaveText('')
    await expect(copyDirectory.locator('svg')).toBeVisible()
    await page.screenshot({ path: info.outputPath('terminal-details-zh.png') })
})


test('file drawer title uses its filename and copies the full workspace path', async ({ page }, info) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem('copied-path', text) } }
    }))
    await page.goto(fixture)
    await page.getByRole('button', { name: 'File preview', exact: true }).tap()
    const drawer = page.getByTestId('chat-preview-drawer')
    await expect(drawer.getByRole('heading', { name: 'example.ts', exact: true })).toBeVisible()
    await expect(drawer.locator('header')).not.toContainText('src/')
    const copy = drawer.getByRole('button', { name: 'Copy path' })
    await expect(copy).toHaveText('')
    await expect(copy.locator('svg')).toBeVisible()
    const headingBox = (await drawer.getByRole('heading', { name: 'example.ts', exact: true }).boundingBox())!
    const copyBox = (await copy.boundingBox())!
    expect(copyBox.x - headingBox.x - headingBox.width).toBeLessThanOrEqual(8)
    expect(copyBox.width).toBeGreaterThanOrEqual(44)
    await copy.tap()
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('copied-path'))).toBe('/workspace/hapi/src/example.ts')
    await page.screenshot({ path: info.outputPath('file-name-copy-path.png') })
})

for (const theme of ['light', 'dark', 'oled']) {
    test(`file drawer restores original diff row colors (${theme})`, async ({ page }, info) => {
        await page.goto(fixture)
        await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
        await page.getByRole('button', { name: 'File preview', exact: true }).tap()
        const drawer = page.getByTestId('chat-preview-drawer')
        await drawer.getByRole('button', { name: 'Changes', exact: true }).tap()
        for (const [text, token] of [['+added line', '--app-diff-added-bg'], ['-removed line', '--app-diff-removed-bg']]) {
            const row = drawer.getByText(text, { exact: true })
            await expect(row).toBeVisible()
            await expect.poll(() => row.evaluate((el, name) => {
                const probe = document.createElement('div')
                probe.style.backgroundColor = `var(${name})`
                el.append(probe)
                const matches = getComputedStyle(el).backgroundColor === getComputedStyle(probe).backgroundColor
                probe.remove()
                return matches
            }, token)).toBe(true)
            await expect(row).toHaveCSS('border-left-width', '2px')
        }
        await expect(drawer).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
        await page.screenshot({ path: info.outputPath(`file-diff-${theme}.png`) })
    })
}
