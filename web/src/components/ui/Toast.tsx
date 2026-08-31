import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { ArrowRightIcon, CheckIcon, CloseIcon } from '@/components/icons'
import type { ToastKind } from '@/lib/toast-context'
import { cn } from '@/lib/utils'

const toastVariants = cva(
    'pointer-events-auto relative w-full overflow-hidden rounded-[18px] border border-[var(--app-border)] bg-[var(--app-bg)] text-left text-[var(--app-fg)] shadow-[0_14px_32px_rgba(15,23,42,0.14)] transition-transform motion-safe:animate-menu-pop',
    {
        variants: {
            kind: {
                success: '',
                info: '',
                warning: '',
                error: ''
            }
        },
        defaultVariants: {
            kind: 'info'
        }
    }
)

export type ToastProps = VariantProps<typeof toastVariants> & {
    kind: ToastKind
    title: string
    body: string
    className?: string
    onClose?: () => void
    onNavigate?: () => void
}

const accentClass: Record<ToastKind, string> = {
    success: 'bg-emerald-500',
    info: 'bg-slate-400',
    warning: 'bg-amber-500',
    error: 'bg-red-500'
}

const iconClass: Record<ToastKind, string> = {
    success: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300',
    info: 'bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300',
    warning: 'bg-amber-50 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
    error: 'bg-red-50 text-red-600 dark:bg-red-400/15 dark:text-red-300'
}

function ToastStatusIcon({ kind }: { kind: ToastKind }) {
    if (kind === 'success') {
        return <CheckIcon className="h-4 w-4" />
    }
    if (kind === 'warning') {
        return (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 8v5" />
                <path d="M12 17h.01" />
                <path d="m10.3 4.8-7 12.1A2 2 0 0 0 5 20h14a2 2 0 0 0 1.7-3.1l-7-12.1a2 2 0 0 0-3.4 0Z" />
            </svg>
        )
    }
    if (kind === 'error') {
        return (
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 12h3l2-4 2 8 1.5-4H18" />
                <rect x="3" y="4" width="18" height="16" rx="5" />
            </svg>
        )
    }
    return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 10v5" />
            <path d="M12 7h.01" />
        </svg>
    )
}

export function Toast({ title, body, onClose, onNavigate, className, kind }: ToastProps) {
    const handleClose = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        onClose?.()
    }

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!onNavigate || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        onNavigate()
    }

    const navigable = Boolean(onNavigate)

    return (
        <div
            className={cn(toastVariants({ kind }), navigable && 'cursor-pointer active:scale-[0.99]', className)}
            role={navigable ? 'button' : kind === 'error' ? 'alert' : 'status'}
            tabIndex={navigable ? 0 : undefined}
            onClick={onNavigate}
            onKeyDown={handleKeyDown}
            data-toast-kind={kind}
        >
            <span className={cn('absolute inset-y-0 left-0 w-1', accentClass[kind])} aria-hidden="true" />
            <div className="flex items-start gap-3 px-4 py-3.5 pl-5">
                <span className={cn('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]', iconClass[kind])}>
                    <ToastStatusIcon kind={kind} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold leading-5">{title}</div>
                    {body ? <div className="mt-0.5 text-[13px] leading-5 text-[var(--app-hint)]">{body}</div> : null}
                </div>
                {navigable ? <ArrowRightIcon className="mt-1.5 h-4 w-4 shrink-0 text-[var(--app-hint)]" /> : null}
                {onClose ? (
                    <button
                        type="button"
                        className="-mr-2 -mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        onClick={handleClose}
                        aria-label="Dismiss"
                    >
                        <CloseIcon className="h-3.5 w-3.5" />
                    </button>
                ) : null}
            </div>
        </div>
    )
}
