import { CircleAlert } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
    SessionDetailStatusNotice,
    type SessionDetailStatusAction
} from '@/components/SessionDetailStatusNotice'
import { cn } from '@/lib/utils'

const AUTO_COLLAPSE_MS = 5_000

type NativeCodexFloatingStatusNoticeTone = 'warning' | 'error'

/**
 * Keeps actionable native-Codex warnings visible without permanently covering
 * the conversation. A changed notice always gets a fresh expanded interval.
 */
export function NativeCodexFloatingStatusNotice(props: {
    tone: NativeCodexFloatingStatusNoticeTone
    title: ReactNode
    detail?: ReactNode
    action?: SessionDetailStatusAction
    secondaryAction?: SessionDetailStatusAction
    /** Stable identity for a meaningful change in the active notice. */
    noticeKey: string
    /** Text exposed by the compact icon-only control. */
    statusLabel: string
    testId?: string
}) {
    const [collapsed, setCollapsed] = useState(false)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const toggleRef = useRef<HTMLButtonElement | null>(null)
    const autoCollapseTimerRef = useRef<number | null>(null)
    const focusToggleOnCollapseRef = useRef(false)

    useLayoutEffect(() => {
        setCollapsed(false)
        const timer = window.setTimeout(() => {
            focusToggleOnCollapseRef.current = rootRef.current?.contains(document.activeElement) ?? false
            setCollapsed(true)
            autoCollapseTimerRef.current = null
        }, AUTO_COLLAPSE_MS)
        autoCollapseTimerRef.current = timer
        return () => {
            window.clearTimeout(timer)
            if (autoCollapseTimerRef.current === timer) {
                autoCollapseTimerRef.current = null
            }
        }
    }, [props.noticeKey])

    useLayoutEffect(() => {
        if (!collapsed || !focusToggleOnCollapseRef.current) {
            return
        }
        focusToggleOnCollapseRef.current = false
        toggleRef.current?.focus()
    }, [collapsed])

    const iconClass = props.tone === 'error' ? 'text-red-500' : 'text-amber-500'
    const toggle = () => {
        if (autoCollapseTimerRef.current !== null) {
            window.clearTimeout(autoCollapseTimerRef.current)
            autoCollapseTimerRef.current = null
        }
        setCollapsed((current) => !current)
    }
    const toggleButton = (
        <button
            ref={toggleRef}
            type="button"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={props.statusLabel}
            title={props.statusLabel}
            data-testid={props.testId ? `${props.testId}-toggle` : undefined}
            className={cn(
                'pointer-events-auto touch-manipulation flex h-11 w-11 shrink-0 items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2',
                collapsed
                    ? 'rounded-r-full rounded-l-none border border-l-0 border-[var(--app-border)] bg-[var(--app-bg)] shadow-[0_8px_24px_rgba(15,23,42,0.10)] hover:bg-[var(--app-secondary-bg)] focus-visible:ring-[var(--app-link)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.30)]'
                    : 'rounded-full hover:bg-[var(--app-muted)] focus-visible:ring-[var(--app-link)]'
            )}
        >
            <CircleAlert className={cn('h-5 w-5', iconClass)} aria-hidden="true" />
        </button>
    )

    return (
        <div
            ref={rootRef}
            data-testid={props.testId}
            data-status-tone={props.tone}
            data-status-collapsed={collapsed ? 'true' : 'false'}
            className={cn(
                'pointer-events-none absolute top-[calc(var(--app-safe-area-top)+4.5rem)] z-30',
                collapsed ? 'left-0' : 'inset-x-0'
            )}
        >
            {collapsed ? (
                <div className="relative">
                    {toggleButton}
                </div>
            ) : (
                <div className="mx-auto w-full max-w-content px-3">
                    <div className="relative">
                        <SessionDetailStatusNotice
                            tone={props.tone}
                            title={props.title}
                            detail={props.detail}
                            action={props.action}
                            secondaryAction={props.secondaryAction}
                        />
                    </div>
                </div>
            )}
        </div>
    )
}
