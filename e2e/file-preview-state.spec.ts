import { expect, test } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true })

for (const variant of [
    { locale: 'zh-CN', theme: 'light', width: 375, height: 812 },
    { locale: 'en', theme: 'dark', width: 812, height: 375 }
]) {
    test(`file preview failure is compact and private (${variant.locale})`, async ({ page }, info) => {
        await page.setViewportSize({ width: variant.width, height: variant.height })
        await page.addInitScript(({ locale, theme }) => {
            localStorage.setItem('hapi-lang', locale)
            document.documentElement.dataset.theme = theme
        }, variant)
        await page.goto('/e2e-fixtures/chat-drawer-fixture.html')
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, variant.theme)
        await page.getByRole('button', { name: 'Unavailable file preview', exact: true }).click()
        const drawer = page.getByTestId('chat-preview-drawer')
        const state = drawer.locator('[data-file-preview-state="missing"]')
        await expect(state).toBeVisible()
        await expect(state).not.toContainText(/ENOENT|private/)
        await expect(drawer.locator('.chat-detail-tabs')).toHaveCount(0)
        await expect(state.getByRole('heading')).toHaveText(variant.locale === 'zh-CN' ? '文件找不到了' : 'File not found')
        const retry = state.getByRole('button')
        await retry.scrollIntoViewIfNeeded()
        const bounds = await retry.boundingBox()
        expect(bounds!.height).toBeGreaterThanOrEqual(44)
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(variant.width)
        await retry.click()
        await expect(state).toBeVisible()
        await page.screenshot({ path: info.outputPath('file-preview-missing.png') })
    })
}
