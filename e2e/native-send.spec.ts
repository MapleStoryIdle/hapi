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
    await expect(page.locator('body')).toHaveJSProperty('scrollWidth', 390)
    await page.screenshot({ path: info.outputPath('thinking-mobile.png') })
    await page.getByRole('button', { name: 'Reply received' }).tap()
    await expect(page.getByTestId('session-thinking-indicator')).toHaveCount(1)
})

test('mobile native composer shows actual model and does not restore timed-out sends', async ({ page }, info) => {
    await page.goto(`${fixture}?page`)
    await expect(page.getByTestId('composer-model-info')).toContainText('gpt-5.6')
    await expect(page.getByTestId('composer-model-info')).toContainText('high')
    const textbox = page.getByRole('textbox')
    await textbox.fill('Keep my message safely')
    await page.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(page.getByText('Keep my message safely', { exact: true })).toBeVisible()
    await expect(textbox).toHaveValue('')
    await expect(page.getByTestId('composer-send-error')).toHaveCount(0)
    await expect(page.getByTestId('composer-model-info')).toBeInViewport()
    await page.screenshot({ path: info.outputPath('native-composer-mobile.png') })
})
