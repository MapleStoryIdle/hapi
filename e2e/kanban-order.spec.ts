import { test, expect } from '@playwright/test'
import { mergeVisibleKanbanOrder } from '../shared/src/kanbanOrder'

test.use({ viewport: { width: 390, height: 844 } })
test('mobile sorting preserves hidden groups and persists the rendered order', async ({ page }, testInfo) => {
    let state = { order: ['pending', 'unviewed', 'pinned', 'custom:empty', 'custom:work', 'recent'], revision: 0 }
    await page.route('**/api/kanban-order', async route => {
        if (route.request().method() === 'PUT') {
            const input = route.request().postDataJSON()
            state = { order: mergeVisibleKanbanOrder(state.order, input.order), revision: state.revision + 1 }
        }
        await route.fulfill({ json: state })
    })
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
    await page.goto('/e2e-fixtures/session-kanban-fixture.html?sorting')
    await page.getByRole('button', { name: 'Section order', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Work', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Empty', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('Fixed at top')).toBeVisible()
    await expect(dialog.getByText('Fixed at bottom')).toBeVisible()
    const handle = dialog.getByRole('button', { name: 'Reorder Recent', exact: true })
    const target = dialog.getByRole('button', { name: 'Reorder Work', exact: true })
    // Wait for the drawer's opening animation before measuring pointer coordinates.
    await handle.click({ trial: true })
    const from = await handle.boundingBox()
    const to = await target.boundingBox()
    if (!from || !to) throw new Error('Missing drag handles')
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect.poll(() => state.revision).toBe(1)
    expect(state.order).toEqual(['pending', 'unviewed', 'pinned', 'custom:empty', 'recent', 'custom:work'])
    await expect(dialog.locator('[data-kanban-sort-lane]').last()).toHaveAttribute('data-kanban-sort-lane', 'custom:work')
    await dialog.evaluate(async el => {
        await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
    })
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('kanban-order-mobile.png') })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.reload()
    await expect(page.locator('[data-kanban-group="custom:work"]')).toBeVisible()
    const ids = await page.locator('[data-kanban-group]').evaluateAll(elements => elements.map(el => el.getAttribute('data-kanban-group')))
    expect(ids[0]).toBe('processing')
    expect(ids.at(-1)).toBe('completed')
    expect(ids.indexOf('recent')).toBeLessThan(ids.indexOf('custom:work'))
    const board = page.getByTestId('session-kanban-board')
    await expect(board).toHaveCSS('gap', '16px')
})
