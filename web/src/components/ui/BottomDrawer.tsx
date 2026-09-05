import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { useMobileSheet } from '@/hooks/useMobileSheet'
import { updateDrawerBackground } from '@/lib/drawer-background'
import { DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
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
    trigger?: ReactElement
    /** Keep the original centered layout on desktop for detail previews. */
    desktopDialog?: boolean
    desktopClassName?: string
    header?: ReactNode
    accessory?: ReactNode
    bodyClassName?: string
    overlayTestId?: string
    closeTestId?: string
    children: ReactNode
    footer?: ReactNode
    busy?: boolean
    testId?: string
}) {
    const { t } = useTranslation()
    const descriptionId = useId()
    const [layer, setLayer] = useState(60)
    const contentRef = useRef<HTMLDivElement>(null)
    const returnFocus = useRef<HTMLElement | null>(null)
    const mobile = useMobileSheet()
    const backgroundId = useRef(Symbol('drawer')).current
    const heightRef = useRef(400)
    const gesture = useRef<{ id: number; start: number; last: number; at: number; velocity: number } | null>(null)
    const [offset, setOffset] = useState(0)
    const [dragging, setDragging] = useState(false)
    const [entered, setEntered] = useState(false)
    const [viewport, setViewport] = useState<{ height: number; bottom: number } | null>(null)

    // Previews can be siblings in React (global providers), not just nested children.
    // Stack above the currently visible sheets, on desktop as well as mobile.
    useLayoutEffect(() => {
        if (!props.open) return
        const others = [...document.querySelectorAll<HTMLElement>('[data-chat-overlay][data-state="open"]')]
            .filter((element) => element !== contentRef.current)
        setLayer(others.reduce((top, element) => Math.max(top, Number(element.style.zIndex) + 1), 60))
    }, [props.open, mobile])

    useEffect(() => {
        if (!props.open || (props.desktopDialog && !mobile)) return
        gesture.current = null
        setDragging(false)
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
    }, [props.open, mobile, props.desktopDialog])

    useEffect(() => {
        if (!props.open || !mobile) return
        updateDrawerBackground(backgroundId, { progress: Math.max(0, 1 - offset / heightRef.current), dragging })
    }, [backgroundId, props.open, mobile, offset, dragging])

    useEffect(() => {
        if (!props.open || !mobile) return
        return () => updateDrawerBackground(backgroundId, null)
    }, [backgroundId, props.open, mobile])

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

    const focusContent = (event: Event) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        event.preventDefault()
        contentRef.current?.focus({ preventScroll: true })
    }
    const restoreFocus = (event: Event) => {
        if (!props.trigger && returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus({ preventScroll: true })
        }
    }

    const style = {
        '--drawer-drag': `${offset}px`,
        '--drawer-overlay-opacity': Math.max(0, 1 - offset / heightRef.current),
        ...(viewport ? { '--drawer-viewport-height': `${viewport.height}px`, '--drawer-bottom': `${viewport.bottom}px` } : {})
    } as CSSProperties

    if (props.desktopDialog && !mobile) {
        return (
            <Dialog.Root open={props.open} onOpenChange={changeOpen}>
                {props.trigger ? <Dialog.Trigger asChild>{props.trigger}</Dialog.Trigger> : null}
                <DialogContent
                    ref={contentRef}
                    className={cn('chat-overlay flex w-[calc(100vw-24px-var(--app-safe-area-left)-var(--app-safe-area-right))] max-h-[calc(100dvh-3rem)] flex-col overflow-hidden rounded-[24px] p-5', props.desktopClassName)}
                    overlayClassName="chat-overlay-scrim"
                    overlayStyle={{ zIndex: layer }}
                    style={{
                        zIndex: layer + 1,
                        left: 'calc(50% + (var(--app-safe-area-left) - var(--app-safe-area-right)) / 2)'
                    }}
                    data-chat-overlay
                    data-testid={props.testId}
                    aria-describedby={props.subtitle ? descriptionId : undefined}
                    aria-busy={props.busy || undefined}
                    onOpenAutoFocus={focusContent}
                    onCloseAutoFocus={restoreFocus}
                    hideClose
                >
                    <header className={cn('chat-overlay-header mb-4 min-w-0 shrink-0', !props.header && 'pr-11')}>
                        {props.header ?? <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>}
                        {props.subtitle ? <Dialog.Description id={descriptionId} className="mt-1 text-sm text-[var(--app-hint)]">{props.subtitle}</Dialog.Description> : null}
                    </header>
                    {props.accessory}
                    <div className={cn('min-h-0 flex-1 overflow-auto overscroll-contain', props.bodyClassName)} data-chat-drawer-body>{props.children}</div>
                    {props.footer ? <div className="chat-sheet-footer shrink-0 mt-4 border-t border-[var(--app-divider)] pt-4">{props.footer}</div> : null}
                    <Dialog.Close type="button" data-testid={props.closeTestId} disabled={props.busy} aria-label={t('button.close')} className="chat-sheet-close absolute right-3 top-3 flex h-11 w-11 items-center justify-center"><CloseIcon className="h-4 w-4" /></Dialog.Close>
                </DialogContent>
            </Dialog.Root>
        )
    }

    return (
        <Dialog.Root open={props.open} onOpenChange={changeOpen}>
            {props.trigger ? <Dialog.Trigger asChild>{props.trigger}</Dialog.Trigger> : null}
            <Dialog.Portal>
                <Dialog.Overlay
                    data-testid={props.overlayTestId}
                    data-dragging={dragging || undefined}
                    className="chat-overlay-scrim question-drawer-overlay fixed inset-0 z-[60] bg-slate-950/35"
                    style={{ ...style, zIndex: layer }}
                />
                <Dialog.Content
                    ref={contentRef}
                    aria-describedby={props.subtitle ? descriptionId : undefined}
                    data-chat-overlay
                    aria-busy={props.busy || undefined}
                    data-chat-detail-drawer={props.desktopDialog || undefined}
                    data-testid={props.testId}
                    data-dragging={dragging || undefined}
                    data-entered={entered || undefined}
                    onAnimationEnd={(event) => {
                        if (event.target === event.currentTarget && props.open) setEntered(true)
                    }}
                    className="chat-overlay question-drawer fixed inset-x-0 z-[61] mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-dialog-bg)] text-[var(--app-fg)] shadow-[0_-16px_60px_rgba(15,23,42,0.18)] outline-none"
                    style={{ ...style, zIndex: layer + 1 }}
                    onOpenAutoFocus={focusContent}
                    onCloseAutoFocus={restoreFocus}
                    onEscapeKeyDown={(event) => { if (props.busy) event.preventDefault() }}
                    onPointerDownOutside={(event) => { if (props.busy) event.preventDefault() }}
                >
                    <div
                        className="shrink-0 touch-none select-none px-5"
                        data-question-drawer-handle
                        onPointerDown={(event) => {
                            if (props.busy || event.button !== 0 || (event.target as HTMLElement).closest('button, a, input, textarea, select')) return
                            heightRef.current = contentRef.current?.offsetHeight || 400
                            gesture.current = { id: event.pointerId, start: event.clientY, last: event.clientY, at: performance.now(), velocity: 0 }
                            setDragging(true)
                            setEntered(true)
                            event.currentTarget.setPointerCapture?.(event.pointerId)
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
                        <header className="chat-overlay-header flex min-h-12 items-start gap-3 pb-4">
                            <div className="min-w-0 flex-1 pt-2">
                                {props.header ?? <Dialog.Title className="[overflow-wrap:anywhere] text-base font-semibold">{props.title}</Dialog.Title>}
                                {props.subtitle ? <Dialog.Description id={descriptionId} className="mt-1 text-sm text-[var(--app-hint)]">{props.subtitle}</Dialog.Description> : null}
                            </div>
                            <Dialog.Close data-testid={props.closeTestId} type="button" disabled={props.busy} aria-label={t('button.close')} className="chat-sheet-close flex h-11 w-11 shrink-0 items-center justify-center">
                                <CloseIcon className="h-4 w-4" />
                            </Dialog.Close>
                        </header>
                    </div>
                    {props.accessory}
                    <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4', props.bodyClassName)} data-question-drawer-body data-chat-drawer-body>
                        {props.children}
                    </div>
                    {props.footer ? <div className="chat-sheet-footer shrink-0 border-t border-[var(--app-divider)] px-5 py-3">{props.footer}</div> : null}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
