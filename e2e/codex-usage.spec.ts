import { test, expect } from '@playwright/test'

for (const variant of [{ lang: 'zh-CN', dark: false, api: false }, { lang: 'en', dark: true, api: true }]) {
    test(`usage drawer mobile ${variant.lang}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.addInitScript(({ lang, dark }) => {
            localStorage.setItem('hapi-lang', lang)
            if (dark) document.documentElement.classList.add('dark')
        }, variant)
        await page.goto(`/e2e-fixtures/codex-usage-fixture.html${variant.api ? '?api' : ''}`)
        await page.getByRole('button').click()
        const dialog = page.getByRole('dialog', { name: variant.lang === 'en' ? 'Usage' : '用量', exact: true })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText('80%')).toBeVisible()
        if (variant.api) {
            await expect(dialog.getByText('API access')).toBeVisible()
            await expect(dialog.getByText('Remaining quota')).toHaveCount(0)
        } else await expect(dialog.getByText('20x Pro · 授权登录')).toBeVisible()
        await dialog.getByRole('button', { name: variant.lang === 'en' ? 'Refresh usage' : '刷新用量' }).click({ trial: true })
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        await dialog.locator('[data-chat-drawer-body]').evaluate(el => { el.scrollTop = 0 })
        await page.screenshot({ path: testInfo.outputPath('usage-mobile.png') })
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await page.setViewportSize({ width: 844, height: 390 })
        await page.getByRole('button').click()
        await expect(dialog).toBeVisible()
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    })
}
