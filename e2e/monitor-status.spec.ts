import { expect, test } from '@playwright/test'

test.use({
    browserName: 'chromium',
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1
})

test('renders compact interactive seven-day HTTP and passive webhook bars at 375px', async ({ page }, info) => {
    await page.goto('/e2e-fixtures/monitor-status-fixture.html')

    expect(page.viewportSize()).toEqual({ width: 375, height: 812 })
    const httpBars = page.locator('[data-testid="monitor-status-bars"][data-monitor-kind="http"]')
    const webhookBars = page.locator('[data-testid="monitor-status-bars"][data-monitor-kind="webhook"]')
    await expect(httpBars.locator('button')).toHaveCount(56)
    await expect(webhookBars.locator('button')).toHaveCount(56)
    await expect(page.getByText('Blue means events were received. Empty time is unknown, never assumed healthy.')).toBeVisible()
    await expect(webhookBars.locator('button[aria-label*="Received"]')).toHaveCount(2)
    await expect(webhookBars.locator('button[aria-label*="passive signal, not uptime"]')).toHaveCount(2)

    const firstHttpBar = httpBars.locator('button').first()
    await firstHttpBar.click()
    await expect(firstHttpBar).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: info.outputPath('monitor-status-375.png'), fullPage: true })
})
