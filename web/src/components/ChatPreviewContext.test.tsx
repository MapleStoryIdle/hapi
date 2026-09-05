import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPreviewProvider, useChatPreview } from './ChatPreviewContext'

vi.mock('./ChatPreviewDrawer', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog">Preview</div> : null }))
afterEach(cleanup)

it('reuses the outer provider so owner callbacks and rendered links share one preview', async () => {
    function Owner() {
        const preview = useChatPreview()
        return <ChatPreviewProvider><button onClick={() => preview?.({ type: 'url', url: 'https://example.com/' })}>Git owner callback</button></ChatPreviewProvider>
    }
    render(<ChatPreviewProvider><Owner /></ChatPreviewProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Git owner callback' }))
    await screen.findByRole('dialog')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
})
