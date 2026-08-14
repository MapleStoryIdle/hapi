import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode
} from 'react'
import { GitBranch } from 'lucide-react'
import { useTranslation } from '@/lib/use-translation'

type SessionActionMenuProps = {
    isOpen: boolean
    onClose: () => void
    sessionActive: boolean
    onRename: () => void
    onExport?: () => void
    onArchive: () => void
    onReopen?: () => void
    onDelete: () => void
    onToggleFiles?: () => void
    filesActive?: boolean
    onToggleOutline?: () => void
    outlineActive?: boolean
    onCreateSideSession?: () => void
    sideSessionPending?: boolean
    anchorPoint: { x: number; y: number }
    menuId?: string
}

type MenuIconProps = {
    className?: string
}

function MenuIcon(props: MenuIconProps & {
    children: ReactNode
    strokeWidth?: number
}) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={props.strokeWidth ?? 1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-[18px] w-[18px] shrink-0 ${props.className ?? ''}`}
            aria-hidden="true"
        >
            {props.children}
        </svg>
    )
}

function EditIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="m14.5 4.5 5 5" />
            <path d="M4 20h5.2L19.7 9.5a2.1 2.1 0 0 0-3-3L6.2 17 4 20Z" />
        </MenuIcon>
    )
}

function ArchiveIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M4.5 7.5h15" />
            <path d="M6 7.5h12v10.25A2.25 2.25 0 0 1 15.75 20h-7.5A2.25 2.25 0 0 1 6 17.75V7.5Z" />
            <path d="M8 4h8l1.5 3.5h-11L8 4Z" />
            <path d="M10 12h4" />
        </MenuIcon>
    )
}

function DownloadIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M12 4v10" />
            <path d="m8.5 10.5 3.5 3.5 3.5-3.5" />
            <path d="M5 16.5v1.25A2.25 2.25 0 0 0 7.25 20h9.5A2.25 2.25 0 0 0 19 17.75V16.5" />
        </MenuIcon>
    )
}

function FilesIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M4.5 7.5V6.25A2.25 2.25 0 0 1 6.75 4h3.1l2 2h5.4a2.25 2.25 0 0 1 2.25 2.25v.5" />
            <path d="M3.75 8.5h16.5l-1 8.4A2.25 2.25 0 0 1 17 19H7a2.25 2.25 0 0 1-2.25-2.1l-1-8.4Z" />
        </MenuIcon>
    )
}

function OutlineIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M9 6.75h10" />
            <path d="M9 12h10" />
            <path d="M9 17.25h10" />
            <path d="M4.5 6.75h.01" strokeWidth="2.6" />
            <path d="M4.5 12h.01" strokeWidth="2.6" />
            <path d="M4.5 17.25h.01" strokeWidth="2.6" />
        </MenuIcon>
    )
}

function SideSessionIcon(props: MenuIconProps) {
    return (
        <GitBranch
            className={`h-[18px] w-[18px] shrink-0 ${props.className ?? ''}`}
            strokeWidth={1.8}
            aria-hidden="true"
        />
    )
}

function ReopenIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M7.5 7.5A7 7 0 1 1 5 12.85" />
            <path d="M4.5 6v4.5H9" />
        </MenuIcon>
    )
}

function TrashIcon(props: MenuIconProps) {
    return (
        <MenuIcon {...props}>
            <path d="M5 7h14" />
            <path d="M9.5 7V5.75A1.75 1.75 0 0 1 11.25 4h1.5a1.75 1.75 0 0 1 1.75 1.75V7" />
            <path d="M7.25 7.25 8 18a2.25 2.25 0 0 0 2.25 2h3.5A2.25 2.25 0 0 0 16 18l.75-10.75" />
            <path d="M10.5 11v5" />
            <path d="M13.5 11v5" />
        </MenuIcon>
    )
}

type MenuPosition = {
    top: number
    left: number
    transformOrigin: string
}

export function SessionActionMenu(props: SessionActionMenuProps) {
    const { t } = useTranslation()
    const {
        isOpen,
        onClose,
        sessionActive,
        onRename,
        onExport,
        onArchive,
        onReopen,
        onDelete,
        onToggleFiles,
        filesActive,
        onToggleOutline,
        outlineActive,
        onCreateSideSession,
        sideSessionPending,
        anchorPoint,
        menuId
    } = props
    const menuRef = useRef<HTMLDivElement | null>(null)
    const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
    const internalId = useId()
    const resolvedMenuId = menuId ?? `session-action-menu-${internalId}`
    const headingId = `${resolvedMenuId}-heading`

    const handleRename = () => {
        onClose()
        onRename()
    }

    const handleArchive = () => {
        onClose()
        onArchive()
    }

    const handleReopen = () => {
        onClose()
        onReopen?.()
    }

    const handleExport = () => {
        onClose()
        onExport?.()
    }

    const handleDelete = () => {
        onClose()
        onDelete()
    }

    const handleToggleFiles = () => {
        onClose()
        onToggleFiles?.()
    }

    const handleToggleOutline = () => {
        onClose()
        onToggleOutline?.()
    }

    const handleCreateSideSession = () => {
        onClose()
        onCreateSideSession?.()
    }

    const updatePosition = useCallback(() => {
        const menuEl = menuRef.current
        if (!menuEl) return

        const menuRect = menuEl.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight
        const padding = 8
        const gap = 8

        const spaceBelow = viewportHeight - anchorPoint.y
        const spaceAbove = anchorPoint.y
        const openAbove = spaceBelow < menuRect.height + gap && spaceAbove > spaceBelow

        let top = openAbove ? anchorPoint.y - menuRect.height - gap : anchorPoint.y + gap
        let left = anchorPoint.x - menuRect.width / 2
        const transformOrigin = openAbove ? 'bottom center' : 'top center'

        top = Math.min(Math.max(top, padding), viewportHeight - menuRect.height - padding)
        left = Math.min(Math.max(left, padding), viewportWidth - menuRect.width - padding)

        setMenuPosition({ top, left, transformOrigin })
    }, [anchorPoint])

    useLayoutEffect(() => {
        if (!isOpen) return
        updatePosition()
    }, [isOpen, updatePosition])

    useEffect(() => {
        if (!isOpen) {
            setMenuPosition(null)
            return
        }

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node
            if (menuRef.current?.contains(target)) return
            onClose()
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose()
            }
        }

        const handleReflow = () => {
            updatePosition()
        }

        document.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('keydown', handleKeyDown)
        window.addEventListener('resize', handleReflow)
        window.addEventListener('scroll', handleReflow, true)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
            document.removeEventListener('keydown', handleKeyDown)
            window.removeEventListener('resize', handleReflow)
            window.removeEventListener('scroll', handleReflow, true)
        }
    }, [isOpen, onClose, updatePosition])

    useEffect(() => {
        if (!isOpen) return

        const frame = window.requestAnimationFrame(() => {
            const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')
            firstItem?.focus()
        })

        return () => window.cancelAnimationFrame(frame)
    }, [isOpen])

    if (!isOpen) return null

    const menuStyle: CSSProperties | undefined = menuPosition
        ? {
            top: menuPosition.top,
            left: menuPosition.left,
            transformOrigin: menuPosition.transformOrigin
        }
        : undefined

    const baseItemClassName =
        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

    return (
        <div
            ref={menuRef}
            className="fixed z-50 min-w-[200px] rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg animate-menu-pop"
            style={menuStyle}
        >
            <div
                id={headingId}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]"
            >
                {t('session.more')}
            </div>
            <div
                id={resolvedMenuId}
                role="menu"
                aria-labelledby={headingId}
                className="flex flex-col gap-1"
            >
                {onToggleFiles ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleToggleFiles}
                    >
                        <FilesIcon className={filesActive ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)]'} />
                        {filesActive ? t('session.view.returnToChat') : t('session.title')}
                    </button>
                ) : null}

                {onToggleOutline ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleToggleOutline}
                    >
                        <OutlineIcon className={outlineActive ? 'text-[var(--app-link)]' : 'text-[var(--app-hint)]'} />
                        {outlineActive ? t('session.outline.close') : t('session.outline.open')}
                    </button>
                ) : null}

                {onCreateSideSession ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)] disabled:cursor-wait disabled:opacity-60`}
                        onClick={handleCreateSideSession}
                        disabled={sideSessionPending}
                    >
                        <SideSessionIcon className="text-[var(--app-hint)]" />
                        {sideSessionPending ? t('session.action.sideSession.creating') : t('session.action.sideSession')}
                    </button>
                ) : null}

                {(onToggleFiles || onToggleOutline || onCreateSideSession) ? (
                    <div className="mx-2 h-px bg-[var(--app-divider)]" />
                ) : null}

                <button
                    type="button"
                    role="menuitem"
                    className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                    onClick={handleRename}
                >
                    <EditIcon className="text-[var(--app-hint)]" />
                    {t('session.action.rename')}
                </button>

                {onExport ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                        onClick={handleExport}
                    >
                        <DownloadIcon className="text-[var(--app-hint)]" />
                        {t('session.action.export')}
                    </button>
                ) : null}

                {sessionActive ? (
                    <button
                        type="button"
                        role="menuitem"
                        className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                        onClick={handleArchive}
                    >
                        <ArchiveIcon className="text-red-500" />
                        {t('session.action.archive')}
                    </button>
                ) : (
                    <>
                        {onReopen ? (
                            <button
                                type="button"
                                role="menuitem"
                                className={`${baseItemClassName} hover:bg-[var(--app-subtle-bg)]`}
                                onClick={handleReopen}
                            >
                                <ReopenIcon className="text-[var(--app-hint)]" />
                                {t('session.action.reopen')}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            role="menuitem"
                            className={`${baseItemClassName} text-red-500 hover:bg-red-500/10`}
                            onClick={handleDelete}
                        >
                            <TrashIcon className="text-red-500" />
                            {t('session.action.delete')}
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
