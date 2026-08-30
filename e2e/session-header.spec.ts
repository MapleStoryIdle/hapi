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
