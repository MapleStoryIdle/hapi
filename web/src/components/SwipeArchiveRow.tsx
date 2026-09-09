import { useRef, useState, type ReactNode } from 'react'
import { Archive } from 'lucide-react'

/** Reveal only: archiving requires an explicit click on the exposed action. */
export function SwipeArchiveRow(props: { children: ReactNode; label: string; onArchive: () => void; disabled?: boolean }) {
    const [offset, setOffset] = useState(0)
    const [dragging, setDragging] = useState(false)
    const gesture = useRef<{ x: number; y: number; initial: number; horizontal: boolean } | null>(null)
    const suppressClick = useRef(false)
    return <div className="relative overflow-hidden rounded-[14px]" data-swipe-archive
        onKeyDown={event => {
            if (event.key === 'Escape') setOffset(0)
            if (event.key === 'ArrowLeft' && !props.disabled) { event.preventDefault(); setOffset(-80) }
        }}
        onContextMenu={event => { if (!props.disabled) { event.preventDefault(); setOffset(-80) } }}>
        <button type="button" disabled={props.disabled || offset === 0} tabIndex={offset < 0 ? 0 : -1} aria-hidden={offset === 0} aria-label={props.label}
            data-kanban-archive
            onClick={() => { setOffset(0); props.onArchive() }}
            className="absolute inset-y-0 right-0 flex w-20 items-center justify-center bg-red-600 text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:invisible">
            <Archive className="h-5 w-5" aria-hidden="true" />
        </button>
        <div style={{ transform: `translateX(${offset}px)`, touchAction: 'pan-y pinch-zoom' }} className={dragging ? 'relative' : 'relative transition-transform duration-200 motion-reduce:transition-none'}
            onDragStart={event => event.preventDefault()}
            onPointerDown={event => {
                suppressClick.current = false
                if (props.disabled || event.button !== 0 || (event.target as HTMLElement).closest('[aria-pressed],input,label')) return
                gesture.current = { x: event.clientX, y: event.clientY, initial: offset, horizontal: false }
            }}
            onPointerMove={event => {
                const current = gesture.current
                if (!current) return
                const dx = event.clientX - current.x, dy = event.clientY - current.y
                if (!current.horizontal) {
                    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { gesture.current = null; return }
                    if (Math.abs(dx) < 10) return
                    current.horizontal = true
                    suppressClick.current = true
                    setDragging(true)
                    event.currentTarget.setPointerCapture(event.pointerId)
                }
                setOffset(Math.max(-80, Math.min(0, current.initial + dx)))
            }}
            onPointerUp={() => { gesture.current = null; setDragging(false); setOffset(value => value < -32 ? -80 : 0) }}
            onPointerCancel={() => { gesture.current = null; setDragging(false); setOffset(0) }}
            onClickCapture={event => {
                if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); suppressClick.current = false; return }
                if (offset < 0) { event.preventDefault(); event.stopPropagation(); setOffset(0) }
            }}
        >{props.children}</div>
    </div>
}
