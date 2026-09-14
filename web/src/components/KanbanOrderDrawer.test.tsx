import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { KanbanOrderDrawer, type KanbanOrderLane } from './KanbanOrderDrawer'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast } from '@/lib/toast-context'

vi.mock('./ui/BottomDrawer', () => ({ BottomDrawer: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => <div role="dialog">{children}{footer}</div> }))
afterEach(cleanup)
const lanes: KanbanOrderLane[] = [
    { id: 'pending', label: 'Pending', icon: null }, { id: 'pinned', label: 'Pinned', icon: null },
    { id: 'custom:work', label: 'Work', icon: null }, { id: 'recent', label: 'Recent', icon: null }
]
function Toasts() { const { toasts } = useToast(); return <>{toasts.map(toast => <div key={toast.id} role="alert">{toast.title}</div>)}</> }
function mount(onSave = vi.fn().mockResolvedValue(undefined)) {
    localStorage.setItem('hapi-lang', 'en')
    const view = (items = lanes, revision = 3) => <I18nProvider><ToastProvider><KanbanOrderDrawer lanes={items} revision={revision} ready saving={false} onSave={onSave} onRetry={() => {}} onClose={() => {}} /><Toasts /></ToastProvider></I18nProvider>
    return { ...render(view()), view, onSave }
}
describe('Kanban order drawer', () => {
    it('keeps locked lanes outside sorting and provides click and keyboard alternatives', () => {
        const { onSave } = mount()
        expect(screen.getByText('Fixed at top')).toBeInTheDocument()
        expect(screen.getByText('Fixed at bottom')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Reorder Thinking' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Move Pinned up' }))
        expect(onSave).toHaveBeenLastCalledWith(['pinned', 'pending', 'custom:work', 'recent'], 3, false)
        fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder Pinned' }), { key: 'ArrowDown' })
        expect(onSave).toHaveBeenLastCalledWith(['pending', 'custom:work', 'pinned', 'recent'], 3, false)
    })
    it('keeps the dragged snapshot stable across remote updates, and saves only on release', () => {
        const { onSave, rerender, view } = mount()
        const handle = screen.getByRole('button', { name: 'Reorder Pending' })
        handle.setPointerCapture = vi.fn()
        // jsdom's PointerEvent is supplied here with the required coordinates.
        const pointer = (type: string, y: number) => {
            const event = new Event(type, { bubbles: true })
            Object.assign(event, { pointerId: 1, button: 0, clientY: y })
            fireEvent(handle, event)
        }
        pointer('pointerdown', 120)
        rerender(view([...lanes].reverse(), 4))
        expect([...screen.getByRole('list').querySelectorAll('li')].map(row => row.getAttribute('data-kanban-sort-lane'))).toEqual(lanes.map(lane => lane.id))
        pointer('pointermove', 240)
        expect(onSave).not.toHaveBeenCalled()
        pointer('pointerup', 240)
        expect(onSave).toHaveBeenCalledWith(['pinned', 'custom:work', 'pending', 'recent'], 3, false)
    })
    it('resets and reports save failures with a toast', async () => {
        const { onSave } = mount(vi.fn().mockRejectedValue(new Error('conflict')))
        fireEvent.click(screen.getByRole('button', { name: 'Reset order' }))
        expect(onSave).toHaveBeenCalledWith([], 3, true)
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Order could not be saved'))
    })
})
