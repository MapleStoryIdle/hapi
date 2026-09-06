import { expect, test, devices } from '@playwright/test'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })
const fixture = '/e2e-fixtures/native-send-fixture.html'

test('a timeout never opens resend actions without an explicit tap', async ({ page }, info) => {
    await page.clock.install()
    await page.goto(`${fixture}?page`)
    await page.getByRole('textbox').fill('Wait for delivery evidence')
    await page.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(page.getByRole('textbox')).toHaveValue('')
    await page.clock.fastForward(30_000)
    const details = page.getByTestId('codex-native-recovery')
    await expect(details).toBeVisible()
    await expect(details).not.toHaveAttribute('open')
    await expect(page.getByText('Message saved. Delivery is not confirmed yet; this does not mean it failed.')).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Send again (may duplicate)' })).not.toBeVisible()
    await details.locator('summary').tap()
    await expect(page.getByRole('button', { name: 'Send again (may duplicate)' })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh status' }).tap()
    await expect(page.getByText('Wait for delivery evidence', { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('composer-send-error')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath('delivery-status-expanded-mobile.png') })
})

test('a confirmed receipt survives a lost HTTP response and a mobile page reload', async ({ page }) => {
    await page.clock.install()
    await page.goto(`${fixture}?page&ack`)
    await page.getByRole('textbox').fill('Confirmed only once')
    await page.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(page.getByRole('textbox')).toHaveValue('')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hapi:native-codex-direct-messages:v1'))).toContain('"deliveryState":"accepted"')
    await page.clock.fastForward(60_000)
    await expect(page.getByTestId('codex-native-recovery')).toHaveCount(0)
    await page.reload()
    await page.clock.fastForward(60_000)
    await expect(page.getByText('Confirmed only once', { exact: true })).toHaveCount(1)
    await expect(page.getByTestId('codex-native-recovery')).toHaveCount(0)
    await expect(page.getByTestId('composer-send-error')).toHaveCount(0)
})

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
    test(`thinking starts warm, breathes and shimmers without layout shifts (${theme})`, async ({ page }, info) => {
        await page.addInitScript(() => { Math.random = () => 0 })
        await page.clock.install()
        await page.goto(fixture)
        await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
        await page.getByRole('button', { name: 'connected', exact: true }).tap()
        const indicators = page.getByTestId('session-thinking-indicator')
        await expect(indicators).toHaveCount(2)
        const indicator = indicators.first()
        for (const status of await indicators.all()) {
            await expect(status).toHaveAttribute('data-tone', 'warm')
        }
        const bounds = await indicator.boundingBox()
        const glyph = indicator.locator('svg')
        const transform = await glyph.evaluate((el) => getComputedStyle(el).transform)
        await expect.poll(() => glyph.evaluate((el) => getComputedStyle(el).transform)).not.toBe(transform)
        const label = indicator.locator('.session-thinking__label')
        const background = await label.evaluate((el) => getComputedStyle(el).backgroundPosition)
        await expect.poll(() => label.evaluate((el) => getComputedStyle(el).backgroundPosition)).not.toBe(background)

        const previousLabels = await indicators.locator('.session-thinking__label').allTextContents()
        await page.clock.fastForward(12_000)
        for (const [index, status] of (await indicators.all()).entries()) {
            await expect(status).toHaveAttribute('data-tone', 'warm')
            await expect(status.locator('.session-thinking__label')).not.toHaveText(previousLabels[index])
        }
        const warmBounds = await indicator.boundingBox()
        expect(warmBounds?.width).toBe(bounds?.width)
        expect(warmBounds?.height).toBe(bounds?.height)
        await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
        await page.screenshot({ path: info.outputPath(`thinking-${theme}.png`) })
    })
}

test('reduced motion disables animation without freezing thinking labels or the clock', async ({ page }) => {
    await page.addInitScript(() => { Math.random = () => 0 })
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
    const previousLabel = await indicators.first().locator('.session-thinking__label').innerText()
    await page.clock.fastForward(12_000)
    await expect(indicators.first()).toHaveAccessibleName('Thinking')
    await expect(indicators.first().locator('.session-thinking__label')).not.toHaveText(previousLabel)
    await expect(indicators.first()).toContainText('12s')
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


for (const native of [false, true]) {
    test(`${native ? 'native' : 'managed HAPI'} composer thinking never moves the input or surrounding content`, async ({ page }, info) => {
        await page.addInitScript(() => { Math.random = () => 0 })
        await page.clock.install()
        await page.goto(`${fixture}${native ? '?nativeComposer' : ''}`)
        const composer = page.getByTestId('managed-composer')
        const indicator = composer.getByTestId('session-thinking-indicator')
        await expect(indicator).toBeVisible()
        const statusBox = (await indicator.boundingBox())!
        const inputBox = (await composer.getByRole('textbox').boundingBox())!
        expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(inputBox.y)
        expect(statusBox.x).toBeLessThan(inputBox.x + inputBox.width / 2)
        const previousLabel = await indicator.locator('.session-thinking__label').innerText()
        await page.clock.fastForward(11_000)
        await expect(indicator.locator('.session-thinking__label')).toHaveText(previousLabel)
        await page.clock.fastForward(1_000)
        await expect(indicator.locator('.session-thinking__label')).not.toHaveText(previousLabel)
        await page.screenshot({ path: info.outputPath(`${native ? 'native' : 'managed'}-thinking.png`) })

        // Both compact and expanded inputs use a stable slot. Include landscape;
        // state changes must not resize the measured dock or move the content below.
        for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
            await page.setViewportSize(viewport)
            for (const draft of ['', 'Draft stays in place']) {
                const textbox = composer.getByRole('textbox')
                await textbox.fill(draft)
                if (!draft) await textbox.blur()
                await expect(composer.getByTestId('happy-composer')).toHaveAttribute('data-mobile-layout-state', draft ? 'expanded' : 'compact')
                // Finish the separate focus/expansion transition before taking
                // a baseline; the thinking animation itself remains enabled.
                await composer.evaluate(async (el) => {
                    await Promise.all(el.getAnimations({ subtree: true })
                        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
                        .map((animation) => animation.finished.catch(() => {})))
                })
                const input = await textbox.boundingBox()
                const dock = await composer.getByTestId('happy-composer').boundingBox()
                const nextContent = await composer.getByRole('button', { name: 'HAPI: wait' }).boundingBox()
                for (const state of ['wait', 'run', 'idle', 'run']) {
                    // Change only the status; a pointer click would also blur the
                    // textarea, independently changing its compact/expanded mode.
                    await composer.getByRole('button', { name: `HAPI: ${state}` }).evaluate((el: HTMLButtonElement) => el.click())
                    await expect(indicator).toHaveCount(state === 'run' ? 1 : 0)
                    expect(await textbox.boundingBox()).toEqual(input)
                    expect(await composer.getByTestId('happy-composer').boundingBox()).toEqual(dock)
                    expect(await composer.getByRole('button', { name: 'HAPI: wait' }).boundingBox()).toEqual(nextContent)
                }
            }
        }
    })
}
