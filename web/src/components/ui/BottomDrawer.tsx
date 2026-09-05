import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export function shouldDismissDrawer(distance: number, velocity: number, height: number): boolean {
    return distance > Math.min(120, height * 0.3) || (distance > 24 && velocity > 0.65)
}

/** Portal-only: opening a question must never move the chat composer. */
export function BottomDrawer(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    subtitle?: string
    trigger: ReactElement
    children: ReactNode
    footer?: ReactNode
    busy?: boolean
    testId?: string
}) {
    const { t } = useTranslation()
    const contentRef = useRef<HTMLDivElement>(null)
    const gesture = useRef<{ id: number; start: number; last: number; at: number; velocity: number } | null>(null)
    const [offset, setOffset] = useState(0)
    const [dragging, setDragging] = useState(false)
    const [entered, setEntered] = useState(false)
    const [viewport, setViewport] = useState<{ height: number; bottom: number } | null>(null)

    useEffect(() => {
        if (!props.open) return
        setOffset(0)
        setEntered(false)
        const measure = () => {
            const visual = window.visualViewport
            setViewport({
                height: visual?.height ?? window.innerHeight,
                bottom: visual ? Math.max(0, window.innerHeight - visual.offsetTop - visual.height) : 0
            })
        }
        measure()
        window.addEventListener('resize', measure)
        window.visualViewport?.addEventListener('resize', measure)
        window.visualViewport?.addEventListener('scroll', measure)
        return () => {
            window.removeEventListener('resize', measure)
            window.visualViewport?.removeEventListener('resize', measure)
            window.visualViewport?.removeEventListener('scroll', measure)
        }
    }, [props.open])

    const changeOpen = (open: boolean) => {
        if (!props.busy) props.onOpenChange(open)
    }

    const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
        const current = gesture.current
        if (!current || current.id !== event.pointerId) return
        gesture.current = null
        setDragging(false)
        const distance = Math.max(0, event.clientY - current.start)
        // A flick counts only while it is still moving, not after a long hold.
        const velocity = performance.now() - current.at < 100 ? current.velocity : 0
        if (!cancelled && !props.busy && shouldDismissDrawer(distance, velocity, contentRef.current?.offsetHeight ?? 400)) {
            changeOpen(false)
        } else {
            setOffset(0)
        }
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
        }
    }

    const style = {
        '--drawer-drag': `${offset}px`,
        ...(viewport ? { '--drawer-viewport-height': `${viewport.height}px`, '--drawer-bottom': `${viewport.bottom}px` } : {})
    } as CSSProperties

    return (
        <Dialog.Root open={props.open} onOpenChange={changeOpen}>
            <Dialog.Trigger asChild>{props.trigger}</Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="question-drawer-overlay fixed inset-0 z-[60] bg-slate-950/35" />
                <Dialog.Content
                    ref={contentRef}
                    aria-describedby={undefined}
                    aria-busy={props.busy || undefined}
                    data-testid={props.testId}
                    data-dragging={dragging || undefined}
                    data-entered={entered || undefined}
                    onAnimationEnd={(event) => {
                        if (event.target === event.currentTarget && props.open) setEntered(true)
                    }}
                    className="question-drawer fixed inset-x-0 z-[61] mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-dialog-bg)] text-[var(--app-fg)] shadow-[0_-16px_60px_rgba(15,23,42,0.18)] outline-none"
                    style={style}
                    onOpenAutoFocus={(event) => {
                        event.preventDefault()
                        contentRef.current?.focus({ preventScroll: true })
                    }}
                    onEscapeKeyDown={(event) => { if (props.busy) event.preventDefault() }}
                    onPointerDownOutside={(event) => { if (props.busy) event.preventDefault() }}
                >
                    <div
                        className="shrink-0 touch-none select-none px-5"
                        data-question-drawer-handle
                        onPointerDown={(event) => {
                            if (props.busy || event.button !== 0 || (event.target as HTMLElement).closest('button')) return
                            gesture.current = { id: event.pointerId, start: event.clientY, last: event.clientY, at: performance.now(), velocity: 0 }
                            setDragging(true)
                            setEntered(true)
                            event.currentTarget.setPointerCapture(event.pointerId)
                        }}
                        onPointerMove={(event) => {
                            const current = gesture.current
                            if (!current || current.id !== event.pointerId) return
                            const now = performance.now()
                            current.velocity = (event.clientY - current.last) / Math.max(1, now - current.at)
                            current.last = event.clientY
                            current.at = now
                            setOffset(Math.max(0, event.clientY - current.start))
                        }}
                        onPointerUp={finishDrag}
                        onPointerCancel={(event) => finishDrag(event, true)}
                        onLostPointerCapture={(event) => finishDrag(event, true)}
                    >
                        <div className="flex h-6 items-center justify-center" aria-hidden="true">
                            <span className="h-1 w-9 rounded-full bg-[var(--app-border)]" />
                        </div>
                        <header className="flex min-h-12 items-start gap-3 pb-3">
                            <div className="min-w-0 flex-1 pt-2">
                                <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>
                                {props.subtitle ? <p className="mt-1 text-xs text-[var(--app-hint)]">{props.subtitle}</p> : null}
                            </div>
                            <Dialog.Close type="button" disabled={props.busy} aria-label={t('button.close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-40">
                                <CloseIcon className="h-4 w-4" />
                            </Dialog.Close>
                        </header>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4" data-question-drawer-body>
                        {props.children}
                    </div>
                    {props.footer ? <div className="shrink-0 border-t border-[var(--app-divider)] px-5 py-3">{props.footer}</div> : null}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
