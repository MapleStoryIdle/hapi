import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatDetailTabs } from './ChatDetailTabs'

afterEach(cleanup)

it('hides zero or one tab and restores navigation when there are multiple tabs', () => {
    const onChange = vi.fn()
    const props = { value: 'source', onChange, idPrefix: 'detail', label: 'Views' }
    const view = render(<ChatDetailTabs {...props} tabs={[]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    view.rerender(<ChatDetailTabs {...props} tabs={[{ value: 'source', label: 'Source' }]} />)
    expect(screen.queryByRole('tablist')).toBeNull()
    view.rerender(<ChatDetailTabs {...props} tabs={[{ value: 'source', label: 'Source' }, { value: 'preview', label: 'Preview' }]} />)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Source' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('preview')
    expect(screen.getByRole('tab', { name: 'Preview' })).toHaveFocus()
})
