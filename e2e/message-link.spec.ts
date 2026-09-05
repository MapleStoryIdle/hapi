import { expect, test, devices } from '@playwright/test'

test.use({ ...devices['iPhone 13'] })

test('message link icons travel with their labels and long labels stay within the message', async ({ page }) => {
    await page.goto('/e2e-fixtures/message-link-fixture.html')
    const links = page.locator('.message-content-link')
    await expect(links).toHaveCount(5)
    for (let i = 0; i < 5; i++) {
        const link = links.nth(i)
        // Leave room for just the icon on the preceding line: the full link
        // must move, rather than leaving the icon behind.
        await link.evaluate((el) => {
            const paragraph = el.closest('p')!
            const prefix = document.createElement('span')
            prefix.dataset.wrapPrefix = 'true'
            prefix.style.display = 'inline-block'
            prefix.style.width = `${paragraph.clientWidth - 22}px`
            prefix.textContent = 'Before'
            paragraph.firstChild!.replaceWith(prefix)
        })
        const boxes = await link.evaluate((el) => {
            const label = el.querySelector('.message-content-link-label')!
            const icon = el.querySelector('svg')!.getBoundingClientRect()
            const range = document.createRange()
            range.selectNodeContents(label)
            const firstText = range.getClientRects()[0]
            const prefix = el.closest('p')!.querySelector('[data-wrap-prefix]')!.getBoundingClientRect()
            const paragraph = el.closest('p')!.getBoundingClientRect()
            return {
                iconTop: icon.top, iconBottom: icon.bottom,
                textTop: firstText.top, textBottom: firstText.bottom,
                prefixBottom: prefix.bottom,
                linkRight: el.getBoundingClientRect().right, paragraphRight: paragraph.right,
                overflow: el.scrollWidth > el.clientWidth + 1
            }
        })
        expect(boxes.iconTop).toBeGreaterThanOrEqual(boxes.prefixBottom - 1)
        expect(boxes.iconBottom).toBeGreaterThan(boxes.textTop)
        expect(boxes.iconTop).toBeLessThan(boxes.textBottom)
        expect(boxes.linkRight).toBeLessThanOrEqual(boxes.paragraphRight + 1)
        expect(boxes.overflow).toBe(false)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
