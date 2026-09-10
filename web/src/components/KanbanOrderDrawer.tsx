import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, GripVertical, LockKeyhole } from 'lucide-react'
import { BottomDrawer } from './ui/BottomDrawer'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

export type KanbanOrderLane = { id: string; label: string; icon: ReactNode }
const ROW_HEIGHT = 56

export function KanbanOrderDrawer(props: {
    lanes: KanbanOrderLane[]
    revision: number
    saving: boolean
    ready: boolean
    onSave: (order: string[], revision: number, reset?: boolean) => Promise<void>
    onRetry: () => void
    onClose: () => void
}) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const list = useRef<HTMLUListElement>(null)
    const [drag, setDrag] = useState<{ id: string; pointer: number; startY: number; scrollTop: number; offset: number; lanes: KanbanOrderLane[]; order: string[]; revision: number } | null>(null)
    const dragRef = useRef(drag)
    const changeDrag = (value: typeof drag) => { dragRef.current = value; setDrag(value) }
    const rows = drag?.lanes ?? props.lanes
    const disabled = props.saving || !props.ready
    const save = (order: string[], revision: number, reset = false) => {
        void props.onSave(order, revision, reset).catch(() => {
            addToast({ title: t('kanbanOrder.saveFailed'), kind: 'error' })
        })
    }
    const move = (id: string, direction: number) => {
        if (disabled || dragRef.current) return
        const order = props.lanes.map(lane => lane.id)
        const index = order.indexOf(id)
        const next = index + direction
        if (next < 0 || next >= order.length) return
        order.splice(index, 1)
        order.splice(next, 0, id)
        save(order, props.revision)
    }
    const start = (event: PointerEvent<HTMLButtonElement>, id: string) => {
        if (disabled || event.button !== 0 || dragRef.current) return
        event.stopPropagation()
        event.currentTarget.setPointerCapture(event.pointerId)
        changeDrag({ id, pointer: event.pointerId, startY: event.clientY, scrollTop: list.current?.parentElement?.scrollTop ?? 0, offset: 0, lanes: props.lanes, order: props.lanes.map(lane => lane.id), revision: props.revision })
    }
    const update = (event: PointerEvent<HTMLButtonElement>) => {
        const current = dragRef.current
        if (!current || current.pointer !== event.pointerId) return
        event.stopPropagation()
        const scroller = list.current?.parentElement
        if (scroller) {
            const rect = scroller.getBoundingClientRect()
            if (event.clientY > rect.bottom - 40) scroller.scrollTop += 12
            else if (event.clientY < rect.top + 40) scroller.scrollTop -= 12
        }
        const index = current.lanes.findIndex(lane => lane.id === current.id)
        const offset = Math.max(-index * ROW_HEIGHT, Math.min((current.lanes.length - index - 1) * ROW_HEIGHT,
            event.clientY - current.startY + (scroller?.scrollTop ?? 0) - current.scrollTop))
        const next = Math.max(0, Math.min(current.lanes.length - 1, index + Math.round(offset / ROW_HEIGHT)))
        const order = current.lanes.map(lane => lane.id).filter(id => id !== current.id)
        order.splice(next, 0, current.id)
        changeDrag({ ...current, offset, order })
    }
    const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
        const current = dragRef.current
        if (!current || current.pointer !== event.pointerId) return
        event.stopPropagation()
        changeDrag(null)
        if (!cancel && current.order.some((id, index) => id !== current.lanes[index]?.id)) save(current.order, current.revision)
    }
    return <BottomDrawer open onOpenChange={open => { if (!open) props.onClose() }} title={t('kanbanOrder.title')} fixedHeight density="compact"
        bodyClassName="px-3 pb-3" footer={<button type="button" disabled={disabled || Boolean(drag)} onClick={() => save([], props.revision, true)} className="min-h-11 w-full text-sm text-[var(--app-link)] disabled:opacity-40">{t('kanbanOrder.reset')}</button>}>
        <div className="flex min-h-11 items-center gap-3 px-3 text-sm text-[var(--app-hint)]"><LockKeyhole className="h-4 w-4" aria-hidden="true" /><span>Thinking</span><span className="ml-auto text-xs">{t('kanbanOrder.fixedTop')}</span></div>
        {!props.ready ? <button type="button" onClick={props.onRetry} className="min-h-11 w-full text-sm text-[var(--app-link)]">{t('kanbanOrder.retry')}</button> : null}
        <ul ref={list} aria-label={t('kanbanOrder.title')} aria-busy={props.saving} className="relative my-1 rounded-2xl bg-[var(--app-subtle-bg)] p-1">
            {rows.map((lane, index) => <li key={lane.id} data-kanban-sort-lane={lane.id} className={`kanban-sort-row relative flex h-14 items-center gap-2 rounded-xl px-1 ${drag?.id === lane.id ? 'z-10 bg-[var(--app-bg)] shadow-lg' : ''}`}
                style={{ transform: drag ? `translateY(${drag.id === lane.id ? drag.offset : (drag.order.indexOf(lane.id) - index) * ROW_HEIGHT}px)` : undefined, transition: drag?.id === lane.id ? 'none' : undefined }}>
                <button type="button" aria-label={t('kanbanOrder.drag', { name: lane.label })} disabled={disabled} className="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-lg text-[var(--app-hint)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    onPointerDown={event => start(event, lane.id)} onPointerMove={update} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
                    onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); move(lane.id, event.key === 'ArrowUp' ? -1 : 1) } }}>
                    <GripVertical className="h-4 w-4" aria-hidden="true" />
                </button>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">{lane.icon}</span>
                <span className="min-w-0 flex-1 truncate text-sm" title={lane.label}>{lane.label}</span>
                <button type="button" disabled={disabled || Boolean(drag) || index === 0} aria-label={t('kanbanOrder.up', { name: lane.label })} onClick={() => move(lane.id, -1)} className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] disabled:opacity-20 focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ArrowUp className="h-4 w-4" aria-hidden="true" /></button>
                <button type="button" disabled={disabled || Boolean(drag) || index === rows.length - 1} aria-label={t('kanbanOrder.down', { name: lane.label })} onClick={() => move(lane.id, 1)} className="flex h-11 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--app-hint)] disabled:opacity-20 focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"><ArrowDown className="h-4 w-4" aria-hidden="true" /></button>
            </li>)}
        </ul>
        <div className="flex min-h-11 items-center gap-3 px-3 text-sm text-[var(--app-hint)]"><LockKeyhole className="h-4 w-4" aria-hidden="true" /><span>{t('kanbanOrder.dates')}</span><span className="ml-auto text-xs">{t('kanbanOrder.fixedBottom')}</span></div>
    </BottomDrawer>
}
