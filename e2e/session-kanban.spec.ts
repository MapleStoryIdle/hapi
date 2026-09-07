import { expect, test, devices } from '@playwright/test'

test.use({ ...devices['iPhone 13'], browserName: 'chromium' })

for (const variant of [
    { locale: 'en', theme: 'light', reducedMotion: false },
    { locale: 'zh-CN', theme: 'dark', reducedMotion: false },
    { locale: 'en', theme: 'oled', reducedMotion: true }
]) {
    test(`board shares thinking animation without moving cards (${variant.locale}, ${variant.theme})`, async ({ page }, info) => {
        await page.addInitScript((locale) => {
            localStorage.setItem('hapi-lang', locale)
            Math.random = () => 0
        }, variant.locale)
        await page.emulateMedia({ reducedMotion: variant.reducedMotion ? 'reduce' : 'no-preference' })
        await page.clock.install()
        await page.goto('/e2e-fixtures/session-kanban-fixture.html')
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, variant.theme)
        const group = page.locator('[data-kanban-group="processing"]')
        const indicator = group.getByTestId('session-thinking-indicator')
        const label = indicator.locator('.session-thinking__label')
        const cards = group.locator('[data-kanban-card-status]')
        await expect(cards).toHaveCount(2)
        await expect(cards.first()).toContainText('alpha task')
        await expect(indicator).toHaveAttribute('data-tone', 'warm')
        await expect(label).toHaveCSS('animation-name', variant.reducedMotion ? 'none' : 'session-thinking-shimmer')
        await expect(indicator.locator('svg')).toHaveCSS('animation-name', variant.reducedMotion ? 'none' : 'session-thinking-breathe')
        await expect(group.locator('[data-kanban-group-count], [data-kanban-card-time], .tabular-nums')).toHaveCount(0)
        await expect(page.locator('[data-kanban-completed-divider]')).toHaveCount(0)
        await expect(page.locator('[data-kanban-group="completed"] h2')).toHaveCount(0)
        const recentIcon = page.locator('[data-kanban-group-icon="recent"]')
        await expect(recentIcon).toHaveCSS('width', '14px')
        await expect(recentIcon).toHaveCSS('height', '14px')
        for (const icon of await page.locator('[data-kanban-date-emoji], .session-thinking__glyph').all()) {
            await expect(icon).toHaveCSS('width', '14px')
            await expect(icon).toHaveCSS('height', '14px')
        }
        const dateHeadings = page.locator('[data-kanban-date-group] h3')
        await expect(dateHeadings).toHaveCount(2)
        for (const heading of await page.locator('.cupertino-kanban-heading h2, .cupertino-kanban-date-heading, .session-thinking__label').all()) {
            await expect(heading).toHaveCSS('font-size', '15px')
            await expect(heading).toHaveCSS('font-weight', '600')
            await expect(heading).toHaveCSS('line-height', '24px')
        }
        const before = await Promise.all((await cards.all()).map((card) => card.boundingBox()))
        const indicatorBefore = await indicator.boundingBox()
        await expect(label).toHaveText(variant.locale === 'en' ? 'Thinking' : '思考中')
        await page.clock.fastForward(11_000)
        await expect(label).toHaveText(variant.locale === 'en' ? 'Thinking' : '思考中')
        await page.clock.fastForward(1_000)
        await expect(label).toHaveText(variant.locale === 'en' ? 'Pondering' : '推敲中')
        expect(await Promise.all((await cards.all()).map((card) => card.boundingBox()))).toEqual(before)
        expect(await indicator.boundingBox()).toEqual(indicatorBefore)
        await expect(cards.first()).toContainText('alpha task')
        await page.screenshot({ path: info.outputPath(`kanban-thinking-${variant.theme}.png`) })
    })
}
