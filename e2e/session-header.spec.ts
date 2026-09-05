import { expect, test, devices } from '@playwright/test'

test.use({
    ...devices['iPhone 13'],
    browserName: 'chromium'
})

test('mobile header keeps its controls tappable while the transparent gap reaches the thread', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-header-fixture.html')

    const shell = page.getByTestId('mobile-layout-header-shell')
    await expect(shell).toHaveCSS('pointer-events', 'none')
    await expect(page.getByTestId('session-header-controls')).toHaveCSS('pointer-events', 'auto')

    const thread = page.getByTestId('session-header-thread-hit-target')
    await thread.tap({ position: { x: 180, y: 40 } })
    await expect(page.getByTestId('session-header-thread-tap-count')).toHaveText('1')

    const title = page.getByRole('button', { name: 'Header test' })
    await title.tap()
    await expect(page.getByRole('dialog', { name: 'Session details' })).toBeVisible()
    await title.tap()
    await expect(page.getByRole('dialog', { name: 'Session details' })).toBeHidden()

    await page.getByTitle('More actions').tap()
    await expect(page.getByRole('menu')).toBeVisible()
    await page.getByTitle('More actions').tap()
    await expect(page.getByRole('menu')).toBeHidden()

    await page.getByTestId('session-header-back').tap()
    await expect(page.getByTestId('session-header-back-count')).toHaveText('1')
})

for (const width of [320, 390, 625, 844]) {
    test(`long titles ellipsize with balanced capsule insets at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: width === 844 ? 390 : 844 })
        for (const title of [
            '这里有什么新功能是我之前fork出来就脱离主版本的，现在要确认完整标题内容',
            'A-very-long-native-Codex-session-title-without-spaces-that-must-not-push-header-actions-off-screen'
        ]) {
            await page.goto(`/e2e-fixtures/session-header-fixture.html?title=${encodeURIComponent(title)}`)
            const button = page.getByRole('button', { name: title, exact: true })
            const label = button.locator('span')
            await expect(label).toHaveCSS('text-overflow', 'ellipsis')
            await expect(label).toHaveCSS('white-space', 'nowrap')
            await expect(label).toHaveCSS('overflow-x', 'hidden')
            expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)

            const capsule = await page.getByTestId('session-header-controls').boundingBox()
            const arrow = await page.getByTestId('session-header-back').locator('polyline').boundingBox()
            const text = await label.boundingBox()
            const action = await page.getByTitle('More actions').boundingBox()
            if (!capsule || !arrow || !text || !action) throw new Error('Header geometry unavailable')
            const leftInset = arrow.x - capsule.x
            const rightInset = capsule.x + capsule.width - text.x - text.width
            // The chevron's painted stroke has fractional bounds; allow two
            // CSS pixels while keeping the spacing on the existing 4px scale.
            expect(Math.abs(leftInset - rightInset)).toBeLessThanOrEqual(2)
            expect(capsule.x + capsule.width).toBeLessThanOrEqual(action.x)
            expect(action.x + action.width).toBeLessThanOrEqual(width)

            if (width === 390 && title.startsWith('这里')) {
                await page.screenshot({ path: testInfo.outputPath('long-title-mobile.png') })
            }
            await button.tap()
            const dialog = page.getByRole('dialog', { name: 'Session details' })
            await expect(dialog.getByText(title, { exact: true })).toBeVisible()
            await button.tap()
            await expect(dialog).toBeHidden()
        }
    })
}
