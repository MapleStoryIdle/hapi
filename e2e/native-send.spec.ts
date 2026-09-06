import { expect, test, devices } from '@playwright/test'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })
const fixture = '/e2e-fixtures/native-send-fixture.html'

test('native and HAPI use one mobile thinking style with immediate transitions', async ({ page }, info) => {
    await page.goto(fixture)
    await expect(page.getByTestId('codex-direct-send-phase-launching')).toContainText('Starting connection')
    await page.getByRole('button', { name: 'matching', exact: true }).tap()
    await expect(page.getByTestId('codex-direct-send-phase-matching')).toContainText('Matching Agent')
    await expect(page.getByTestId('codex-direct-send-phase-launching')).toHaveCount(0)
    await page.getByRole('button', { name: 'connected', exact: true }).tap()
    await expect(page.getByTestId('session-thinking-indicator')).toHaveCount(2)
    for (const indicator of await page.getByTestId('session-thinking-indicator').all()) {
        await expect(indicator.locator('svg')).toHaveCSS('animation-name', 'session-thinking-breathe')
        await expect(indicator.locator('.session-thinking__label')).toHaveCSS('animation-name', 'session-thinking-shimmer')
    }
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
    await page.screenshot({ path: info.outputPath('thinking-mobile.png') })
    await page.getByRole('button', { name: 'Reply received' }).tap()
    await expect(page.getByTestId('session-thinking-indicator')).toHaveCount(1)
})

for (const theme of ['light', 'dark', 'oled']) {
    test(`thinking breathes and shimmers, then warms without layout shifts (${theme})`, async ({ page }, info) => {
        await page.clock.install()
        await page.goto(fixture)
        await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
        await page.getByRole('button', { name: 'connected', exact: true }).tap()
        const indicators = page.getByTestId('session-thinking-indicator')
        await expect(indicators).toHaveCount(2)
        const indicator = indicators.first()
        await expect(indicator).toHaveAttribute('data-tone', 'default')
        const bounds = await indicator.boundingBox()
        const glyph = indicator.locator('svg')
        const transform = await glyph.evaluate((el) => getComputedStyle(el).transform)
        await expect.poll(() => glyph.evaluate((el) => getComputedStyle(el).transform)).not.toBe(transform)
        const label = indicator.locator('.session-thinking__label')
        const background = await label.evaluate((el) => getComputedStyle(el).backgroundPosition)
        await expect.poll(() => label.evaluate((el) => getComputedStyle(el).backgroundPosition)).not.toBe(background)

        await page.clock.fastForward(13_000)
        for (const status of await indicators.all()) {
            await expect(status).toHaveAttribute('data-tone', 'warm')
            await expect(status).toHaveAccessibleName('Pondering')
        }
        const warmBounds = await indicator.boundingBox()
        expect(warmBounds?.width).toBe(bounds?.width)
        expect(warmBounds?.height).toBe(bounds?.height)
        await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
        await page.screenshot({ path: info.outputPath(`thinking-${theme}.png`) })
    })
}

test('reduced motion keeps the thinking text still but the elapsed clock live', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.clock.install()
    await page.goto(fixture)
    await page.getByRole('button', { name: 'connected', exact: true }).tap()
    const indicators = page.getByTestId('session-thinking-indicator')
    await expect(indicators).toHaveCount(2)
    for (const indicator of await indicators.all()) {
        await expect(indicator).toHaveAttribute('data-reduced-motion', 'true')
        await expect(indicator.locator('svg')).toHaveCSS('animation-name', 'none')
        await expect(indicator.locator('.session-thinking__label')).toHaveCSS('animation-name', 'none')
        await expect(indicator.locator('.session-thinking__label')).toHaveCSS('background-image', 'none')
    }
    await page.clock.fastForward(24_000)
    await expect(indicators.first()).toHaveAccessibleName('Thinking')
    await expect(indicators.first()).toContainText('24s')
    await page.getByRole('button', { name: 'Reply received' }).tap()
    await expect(indicators).toHaveCount(1)
})

test('mobile native composer shows actual model and does not restore timed-out sends', async ({ page }, info) => {
    await page.goto(`${fixture}?page`)
    const model = page.getByTestId('composer-model-info')
    await expect(model).toContainText('5.6')
    await expect(model).toBeDisabled()
    await expect(page.getByTestId('composer-model-info')).toContainText('high')
    const textbox = page.getByRole('textbox')
    await textbox.fill('Keep my message safely')
    await expect(model).toHaveAccessibleName(/gpt-5.6 high.*read-only/)
    await expect(model).toBeInViewport()
    expect(await textbox.evaluate((el) => el.closest('.grid')?.contains(document.querySelector('[data-testid="composer-model-info"]')))).toBe(true)
    await page.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(page.getByText('Keep my message safely', { exact: true })).toBeVisible()
    await expect(textbox).toHaveValue('')
    await expect(page.getByTestId('composer-send-error')).toHaveCount(0)
    await textbox.focus()
    await expect(model).toBeInViewport()
    await page.screenshot({ path: info.outputPath('native-composer-mobile.png') })
})
