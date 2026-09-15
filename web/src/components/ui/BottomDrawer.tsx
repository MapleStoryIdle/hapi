import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactElement, type ReactNode } from 'react'
import { useMobileSheet } from '@/hooks/useMobileSheet'
import { getKeyboardViewportState } from '@/hooks/useViewportHeight'
import { updateDrawerBackground } from '@/lib/drawer-background'
import { DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CloseIcon } from '@/components/icons'
import { useTranslation } from '@/lib/use-translation'

export function shouldDismissDrawer(distance: number, velocity: number, height: number): boolean {
    return distance > Math.min(120, height * 0.3) || (distance > 24 && velocity > 0.65)
}

export function drawerDragSize(height: number, distance: number, limit: number) {
    const requested = Math.max(120, height - distance)
    return { height: Math.min(limit, requested), offset: -Math.min(12, Math.max(0, requested - limit) * 0.15) }
}

/** Portal-only: opening a question must never move the chat composer. */
export function BottomDrawer(props: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    subtitle?: ReactNode
    trigger?: ReactElement
    /** Detail previews may be denser; approval sheets retain their spacing. */
    density?: 'compact'
    /** Keep the original centered layout on desktop for detail previews. */
    desktopDialog?: boolean
    /**
     * Editable content cannot live in a phone sheet: iOS can cover it with the
     * software keyboard. Render it as a VisualViewport-aware dialog instead.
     */
    inputDialog?: boolean
    desktopClassName?: string
    /** Explicit desktop dialog height; inline so app-safe-dialog cannot collapse it. */
    desktopHeight?: CSSProperties['height']
    /** Fill 70% of the visible viewport, including header and safe-area padding. */
    fixedHeight?: boolean
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
    const [nested, setNested] = useState(false)
    const contentRef = useRef<HTMLDivElement>(null)
    const returnFocus = useRef<HTMLElement | null>(null)
    const mobile = useMobileSheet()
    const useDesktopDialog = !mobile && Boolean(props.inputDialog || props.desktopDialog)
    const keyboardSafeDialog = Boolean(props.inputDialog && mobile)
    const backgroundId = useRef(Symbol('drawer')).current
    const heightRef = useRef(400)
    const resizeFrom = useRef<number | null>(null)
    const resizeAnimation = useRef<Animation | null>(null)
    const expandedLimit = useRef(800)
    const stableViewportHeight = useRef(0)
    const keyboardWasOpen = useRef(false)
    const viewportOpenCycle = useRef(false)
    const drawerOpenCycle = useRef(false)
    const gesture = useRef<{ id: number; start: number; last: number; at: number; velocity: number } | null>(null)
    const [offset, setOffset] = useState(0)
    const [dragging, setDragging] = useState(false)
    const [entered, setEntered] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [dragHeight, setDragHeight] = useState<number | null>(null)
    // Keep the last visible content while Radix runs its exit animation.
    const lastContent = useRef({ children: props.children, header: props.header, accessory: props.accessory, footer: props.footer })
    useLayoutEffect(() => {
        if (props.open) lastContent.current = { children: props.children, header: props.header, accessory: props.accessory, footer: props.footer }
    })
    const content = props.open ? props : lastContent.current
    const [viewport, setViewport] = useState<{
        height: number
        top: number
        bottom: number
        keyboardBottom: number
        keyboardOpen: boolean
        fixedViewport: 'layout' | 'visual'
    } | null>(null)

    useLayoutEffect(() => {
        if (dragging || resizeFrom.current === null || !props.open) return
        const element = contentRef.current
        const from = resizeFrom.current
        resizeFrom.current = null
        resizeAnimation.current?.cancel()
        if (!element?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        // Height changes are confined to the portal; page/composer layout is untouched.
        const maxHeight = `${expandedLimit.current}px`
        resizeAnimation.current = element.animate([{ height: `${from}px`, maxHeight }, { height: `${element.offsetHeight}px`, maxHeight }], {
            duration: 300, easing: 'cubic-bezier(0.32, 0.72, 0, 1)'
        })
    }, [expanded, dragging, dragHeight, props.open])
    useEffect(() => () => resizeAnimation.current?.cancel(), [])

    // Reset entrance state once per closed -> open cycle. Layout changes while
    // the drawer is already open must not replay the entrance animation.
    useLayoutEffect(() => {
        if (!props.open) {
            drawerOpenCycle.current = false
            viewportOpenCycle.current = false
            stableViewportHeight.current = 0
            keyboardWasOpen.current = false
            return
        }
        if (drawerOpenCycle.current) return
        drawerOpenCycle.current = true
        gesture.current = null
        setDragging(false)
        setOffset(0)
        setEntered(false)
        setExpanded(false)
        setDragHeight(null)
    }, [props.open])

    useLayoutEffect(() => {
        if (!props.open || !keyboardSafeDialog || !viewport) return
        const frame = window.requestAnimationFrame(() => {
            const dialog = contentRef.current
            const active = document.activeElement
            if (!dialog || !(active instanceof HTMLElement) || !dialog.contains(active)) return
            const body = active.closest<HTMLElement>('[data-chat-drawer-body]')
            if (!body) return
            const field = active.getBoundingClientRect()
            const visible = body.getBoundingClientRect()
            const gap = 12
            if (field.bottom > visible.bottom - gap) body.scrollTop += field.bottom - visible.bottom + gap
            else if (field.top < visible.top + gap) body.scrollTop -= visible.top - field.top + gap
        })
        return () => window.cancelAnimationFrame(frame)
    }, [keyboardSafeDialog, props.open, viewport?.height, viewport?.keyboardOpen, viewport?.top])

    // Previews can be siblings in React (global providers), not just nested children.
    // Stack above the currently visible sheets, on desktop as well as mobile.
    useLayoutEffect(() => {
        if (!props.open) return
        const others = [...document.querySelectorAll<HTMLElement>('[data-chat-overlay][data-state="open"]')]
            .filter((element) => element !== contentRef.current)
        setNested(others.length > 0)
        setLayer(others.reduce((top, element) => Math.max(top, Number(element.style.zIndex) + 1), 60))
    }, [props.open, mobile])

    useLayoutEffect(() => {
        if (!props.open || useDesktopDialog) return
        // A mobile sheet can switch to an input dialog without closing (for
        // example, selecting "edit group"). Keep the pre-keyboard viewport
        // baseline for that whole open cycle. Resetting it during the switch
        // lets iOS report only its already-shrunken viewport, so the dialog is
        // mistaken for a keyboard-closed surface and ends up behind the keys.
        if (!viewportOpenCycle.current) {
            stableViewportHeight.current = 0
            keyboardWasOpen.current = false
            viewportOpenCycle.current = true
        }
        const measure = (confirmKeyboardOpen = false) => {
            const visual = window.visualViewport
            const topInset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-safe-area-top')) || 0
            const height = visual?.height ?? window.innerHeight
            const top = visual?.offsetTop ?? 0
            const layoutHeight = Math.max(document.documentElement.clientHeight, window.innerHeight)
            const active = document.activeElement
            const textEntryFocused = active instanceof HTMLTextAreaElement
                || (active instanceof HTMLInputElement && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(active.type))
                || (active instanceof HTMLElement && active.isContentEditable)
            const keyboardState = getKeyboardViewportState({
                layoutViewportHeight: layoutHeight,
                visualViewportHeight: height,
                hasFocusedTextEntry: textEntryFocused,
                stableViewportHeight: stableViewportHeight.current,
                wasKeyboardOpen: keyboardWasOpen.current,
                confirmKeyboardOpen
            })
            const keyboardOpen = document.documentElement.dataset.appKeyboardOpen === 'true' || keyboardState.keyboardOpen
            stableViewportHeight.current = keyboardOpen
                ? Math.max(stableViewportHeight.current, layoutHeight, height)
                : keyboardState.stableViewportHeight
            keyboardWasOpen.current = keyboardOpen
            // iOS can either keep fixed positioning in the layout viewport or
            // move it into the shrunken visual viewport.  Raising a dialog by
            // the keyboard height in the latter case sends it above the screen.
            // Home Screen WebKit can shrink `innerHeight` to the visual
            // viewport while still resolving fixed-position `bottom` against
            // the old layout viewport. Treating equal heights as proof that
            // fixed positioning follows the visual viewport leaves the dialog
            // underneath the keyboard. The standalone marker is a stronger
            // signal: keep using the pre-keyboard baseline there.
            const iosStandalone = document.documentElement.dataset.iosStandalone === 'true'
            const fixedTracksVisualViewport = keyboardOpen
                && !iosStandalone
                && Math.abs(window.innerHeight - height) < 2
            const layoutBottomReference = Math.max(layoutHeight, stableViewportHeight.current)
            const keyboardBottom = visual && keyboardOpen && !fixedTracksVisualViewport
                ? Math.max(0, layoutBottomReference - top - height)
                : 0
            expandedLimit.current = Math.max(0, height - topInset - 12)
            setViewport({
                height,
                top,
                bottom: visual ? Math.max(0, layoutHeight - top - height) : 0,
                keyboardBottom,
                keyboardOpen,
                fixedViewport: fixedTracksVisualViewport ? 'visual' : 'layout'
            })
        }
        measure()
        const onWindowResize = () => measure()
        const onFocusChange = () => measure()
        const onVisualResize = () => measure(true)
        const onVisualScroll = () => measure()
        window.addEventListener('resize', onWindowResize)
        document.addEventListener('focusin', onFocusChange)
        document.addEventListener('focusout', onFocusChange)
        window.visualViewport?.addEventListener('resize', onVisualResize)
        window.visualViewport?.addEventListener('scroll', onVisualScroll)
        return () => {
            window.removeEventListener('resize', onWindowResize)
            document.removeEventListener('focusin', onFocusChange)
            document.removeEventListener('focusout', onFocusChange)
            window.visualViewport?.removeEventListener('resize', onVisualResize)
            window.visualViewport?.removeEventListener('scroll', onVisualScroll)
        }
    }, [props.open, mobile, props.desktopDialog, props.inputDialog, useDesktopDialog])

    useEffect(() => {
        if (!props.open || !mobile) return
        // A typing dialog is already isolated by its scrim. Do not also shrink
        // the chat stage, which can make iOS recalculate fixed coordinates
        // while the keyboard is opening.
        if (keyboardSafeDialog) {
            updateDrawerBackground(backgroundId, null)
            return
        }
        updateDrawerBackground(backgroundId, { progress: Math.min(1, Math.max(0, 1 - offset / heightRef.current)), dragging })
    }, [backgroundId, props.open, mobile, keyboardSafeDialog, offset, dragging])

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
        resizeFrom.current = contentRef.current?.getBoundingClientRect().height ?? null
        setDragging(false)
        const distance = event.clientY - current.start
        // A flick counts only while it is still moving, not after a long hold.
        const velocity = performance.now() - current.at < 100 ? current.velocity : 0
        const dismissing = !cancelled && !props.busy && !expanded && shouldDismissDrawer(distance, velocity, heightRef.current)
        if (!cancelled && !props.busy) {
            if (distance < -48 || (distance < -24 && velocity < -0.65)) setExpanded(true)
            else if (shouldDismissDrawer(distance, velocity, heightRef.current)) {
                if (expanded) setExpanded(false)
                else changeOpen(false)
            }
        }
        if (!dismissing) setOffset(0)
        setDragHeight(null)
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
        }
    }

    const focusContent = (event: Event) => {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        event.preventDefault()
        const initialFocus = contentRef.current?.querySelector<HTMLElement>('[data-drawer-initial-focus]')
        if (initialFocus && !initialFocus.hasAttribute('disabled')) {
            initialFocus.focus({ preventScroll: true })
            return
        }
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
        '--drawer-overlay-opacity': Math.min(1, Math.max(0, 1 - offset / heightRef.current)),
        ...(viewport ? {
            '--drawer-viewport-height': `${viewport.height}px`,
            '--drawer-viewport-top': `${viewport.top}px`,
            '--drawer-bottom': `${viewport.bottom}px`,
            '--drawer-keyboard-bottom': `${viewport.keyboardBottom}px`
        } : {})
    } as CSSProperties

    // Mobile input dialogs deliberately do not use DialogContent. Its desktop
    // centering utilities include left: 50% and translateX(-50%), which can be
    // resolved in different coordinate spaces while iOS animates the keyboard.
    // This branch owns every edge and never applies a positional transform.
    const keyboardSafeDialogStyle: CSSProperties = keyboardSafeDialog ? {
        left: 'calc(var(--app-safe-area-left) + var(--app-mobile-input-dialog-edge-gap))',
        right: 'calc(var(--app-safe-area-right) + var(--app-mobile-input-dialog-edge-gap))',
        top: 'auto',
        width: 'auto',
        maxWidth: 'none',
        bottom: viewport?.keyboardOpen
            ? 'calc(var(--drawer-keyboard-bottom) + var(--app-mobile-input-dialog-keyboard-gap))'
            : 'calc(var(--app-safe-area-bottom) + var(--app-mobile-input-dialog-edge-gap))',
        transform: 'none',
        ...(viewport ? {
            // When the keyboard is closed, the bottom anchor already includes
            // the home-indicator inset. Subtract it from the height cap too;
            // otherwise that inset is effectively borrowed from the top and a
            // tall dialog can cross into the status-bar / Dynamic Island area.
            maxHeight: viewport.keyboardOpen
                ? 'calc(var(--drawer-viewport-height) - var(--app-safe-area-top) - var(--app-mobile-input-dialog-edge-gap) - var(--app-mobile-input-dialog-keyboard-gap))'
                : 'calc(var(--drawer-viewport-height) - var(--app-safe-area-top) - var(--app-safe-area-bottom) - var(--app-mobile-input-dialog-edge-gap) - var(--app-mobile-input-dialog-edge-gap))'
        } : {})
    } : {}

    if (keyboardSafeDialog) {
        return (
            <Dialog.Root open={props.open} onOpenChange={changeOpen}>
                {props.trigger ? <Dialog.Trigger asChild>{props.trigger}</Dialog.Trigger> : null}
                <Dialog.Portal>
                    <Dialog.Overlay
                        className="chat-overlay-scrim fixed inset-0 bg-slate-950/35"
                        style={{ zIndex: layer }}
                    />
                    <Dialog.Content
                        ref={contentRef}
                        className={cn('keyboard-input-dialog chat-overlay fixed flex flex-col overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-[var(--app-dialog-bg)] p-5 text-[var(--app-fg)] shadow-2xl outline-none', props.desktopClassName)}
                        style={{ zIndex: layer + 1, ...style, ...keyboardSafeDialogStyle }}
                        data-chat-overlay
                        data-keyboard-safe-dialog="true"
                        data-keyboard-open={viewport?.keyboardOpen ? 'true' : undefined}
                        data-keyboard-fixed-viewport={viewport?.keyboardOpen ? viewport.fixedViewport : undefined}
                        data-density={props.density}
                        data-testid={props.testId}
                        aria-describedby={props.subtitle ? descriptionId : undefined}
                        aria-busy={props.busy || undefined}
                        onOpenAutoFocus={focusContent}
                        onCloseAutoFocus={restoreFocus}
                        onEscapeKeyDown={(event) => { if (props.busy) event.preventDefault() }}
                        onPointerDownOutside={(event) => { if (props.busy) event.preventDefault() }}
                    >
                        <header className={cn('chat-overlay-header mb-4 min-w-0 shrink-0', !props.header && 'pr-11')}>
                            {content.header ?? <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>}
                            {props.subtitle ? <Dialog.Description id={descriptionId} className="mt-1 text-sm text-[var(--app-hint)]">{props.subtitle}</Dialog.Description> : null}
                        </header>
                        {content.accessory}
                        <div className={cn('min-h-0 flex-1 overflow-auto overscroll-contain', props.bodyClassName)} data-chat-drawer-body>{content.children}</div>
                        {content.footer ? <div className="chat-sheet-footer mt-4 shrink-0 border-t border-[var(--app-divider)] pt-4">{content.footer}</div> : null}
                        <Dialog.Close type="button" data-testid={props.closeTestId} disabled={props.busy} aria-label={t('button.close')} className="chat-sheet-close absolute right-3 top-3 flex h-11 w-11 items-center justify-center"><CloseIcon className="h-4 w-4" /></Dialog.Close>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        )
    }

    if (useDesktopDialog) {
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
                        left: 'calc(50% + (var(--app-safe-area-left) - var(--app-safe-area-right)) / 2)',
                        ...(props.desktopHeight ? { height: props.desktopHeight } : {}),
                        ...style
                    }}
                    data-chat-overlay
                    data-desktop-dialog="true"
                    data-density={props.density}
                    data-testid={props.testId}
                    aria-describedby={props.subtitle ? descriptionId : undefined}
                    aria-busy={props.busy || undefined}
                    onOpenAutoFocus={focusContent}
                    onCloseAutoFocus={restoreFocus}
                    onEscapeKeyDown={(event) => { if (props.busy) event.preventDefault() }}
                    onPointerDownOutside={(event) => { if (props.busy) event.preventDefault() }}
                    hideClose
                >
                    <header className={cn('chat-overlay-header mb-4 min-w-0 shrink-0', !props.header && 'pr-11')}>
                        {content.header ?? <Dialog.Title className="text-base font-semibold">{props.title}</Dialog.Title>}
                        {props.subtitle ? <Dialog.Description id={descriptionId} className="mt-1 text-sm text-[var(--app-hint)]">{props.subtitle}</Dialog.Description> : null}
                    </header>
                    {content.accessory}
                    <div className={cn('min-h-0 flex-1 overflow-auto overscroll-contain', props.bodyClassName)} data-chat-drawer-body>{content.children}</div>
                    {content.footer ? <div className="chat-sheet-footer shrink-0 mt-4 border-t border-[var(--app-divider)] pt-4">{content.footer}</div> : null}
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
                    className={cn('chat-overlay-scrim question-drawer-overlay fixed inset-0 z-[60]', nested ? 'bg-transparent' : 'bg-slate-950/35')}
                    style={{ ...style, zIndex: layer, ...(nested ? { background: 'transparent' } : {}) }}
                />
                <Dialog.Content
                    ref={contentRef}
                    aria-describedby={props.subtitle ? descriptionId : undefined}
                    data-chat-overlay
                    data-density={props.density}
                    aria-busy={props.busy || undefined}
                    data-chat-detail-drawer={props.desktopDialog || undefined}
                    data-testid={props.testId}
                    data-dragging={dragging || undefined}
                    data-entered={entered || undefined}
                    data-expanded={expanded || undefined}
                    onAnimationEnd={(event) => {
                        if (event.target === event.currentTarget && props.open) setEntered(true)
                    }}
                    className="chat-overlay question-drawer fixed inset-x-0 z-[61] mx-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-dialog-bg)] text-[var(--app-fg)] shadow-[0_-16px_60px_rgba(15,23,42,0.18)] outline-none"
                    style={{ ...style, zIndex: layer + 1,
                        ...(expanded ? { height: 'var(--drawer-expanded-height)' } : props.fixedHeight ? { height: 'calc(var(--drawer-viewport-height, 100dvh) * 0.7)' } : {}),
                        ...(dragHeight !== null ? { height: `${dragHeight}px`, maxHeight: 'var(--drawer-expanded-height)' } : {})
                    }}
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
                            resizeAnimation.current?.cancel()
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
                            const distance = event.clientY - current.start
                            if (expanded || distance < 0) {
                                // Resize only the portal, never the underlying composer/page.
                                const next = drawerDragSize(heightRef.current, distance, expandedLimit.current)
                                setDragHeight(next.height)
                                setOffset(next.offset)
                            } else setOffset(distance)
                        }}
                        onPointerUp={finishDrag}
                        onPointerCancel={(event) => finishDrag(event, true)}
                        onLostPointerCapture={(event) => finishDrag(event, true)}
                    >
                        <div className="flex h-6 items-center justify-center" role="separator" tabIndex={0}
                            aria-label={t(expanded ? 'drawer.collapse' : 'drawer.expand')} aria-orientation="horizontal" aria-valuenow={expanded ? 100 : 70}
                            onKeyDown={(event) => {
                                if (props.busy || !['ArrowUp', 'ArrowDown', 'Enter', ' '].includes(event.key)) return
                                event.preventDefault()
                                resizeFrom.current = contentRef.current?.getBoundingClientRect().height ?? null
                                setExpanded(event.key === 'ArrowUp' || (event.key !== 'ArrowDown' && !expanded))
                                setEntered(true)
                            }}>
                            <span className="h-1 w-9 rounded-full bg-[var(--app-border)]" />
                        </div>
                        <header className="chat-overlay-header flex min-h-12 items-start gap-3 pb-4">
                            <div className="min-w-0 flex-1 pt-2">
                                {content.header ?? <Dialog.Title className="[overflow-wrap:anywhere] text-base font-semibold">{props.title}</Dialog.Title>}
                                {props.subtitle ? <Dialog.Description id={descriptionId} className="mt-1 text-sm text-[var(--app-hint)]">{props.subtitle}</Dialog.Description> : null}
                            </div>
                            <Dialog.Close data-testid={props.closeTestId} type="button" disabled={props.busy} aria-label={t('button.close')} className="chat-sheet-close flex h-11 w-11 shrink-0 items-center justify-center">
                                <CloseIcon className="h-4 w-4" />
                            </Dialog.Close>
                        </header>
                    </div>
                    {content.accessory}
                    <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4', props.bodyClassName)} data-question-drawer-body data-chat-drawer-body>
                        {content.children}
                    </div>
                    {content.footer ? <div className="chat-sheet-footer shrink-0 border-t border-[var(--app-divider)] px-5 py-3">{content.footer}</div> : null}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
