import { test, expect } from '@playwright/test'

test.use({ hasTouch: true, isMobile: true })

for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    test(`thinking stays in the thread, not the dock (${viewport.width}px)`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: viewport.width === 375 ? 'light' : 'dark' })
        await page.goto('/e2e-fixtures/native-send-fixture.html?page&controls')
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, viewport.width === 375 ? 'light' : 'dark')
        const row = page.getByTestId('thread-thinking-message')
        await expect(row).toBeVisible()
        await expect(page.locator('.happy-thread-messages').getByTestId('session-thinking-indicator')).toHaveCount(1)
        await expect(page.getByTestId('happy-composer').getByTestId('session-thinking-indicator')).toHaveCount(0)
        await expect(page.getByTestId('composer-thinking-slot')).toHaveCount(0)
        const composer = page.getByTestId('happy-composer')
        const before = await composer.boundingBox()
        expect(before).not.toBeNull()
        const rowBox = await row.boundingBox()
        expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(before!.y)
        const dot = await page.locator('.aui-md').first().evaluate((element) => {
            element.setAttribute('data-status', 'running')
            const last = element.lastElementChild ?? element
            return getComputedStyle(last, '::after').content
        })
        expect(['none', 'normal', '""']).toContain(dot)
        await page.getByRole('button', { name: 'Abort', exact: true }).click()
        await expect(row).toHaveCount(0)
        const after = await composer.boundingBox()
        expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
        expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1)
    })
}
