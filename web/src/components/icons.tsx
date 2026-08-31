import type { ReactNode } from 'react'

type IconProps = {
    className?: string
}

function createIcon(paths: ReactNode, props: IconProps, strokeWidth = 1.5) {
    return (
        <svg
            className={props.className ?? 'h-4 w-4'}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {paths}
        </svg>
    )
}

export function CloseIcon(props: IconProps) {
    return createIcon(
        <path d="M6 18 18 6M6 6l12 12" />,
        props,
        2
    )
}

export function ShareIcon(props: IconProps) {
    return createIcon(
        <path d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15m0-3-3-3m0 0-3 3m3-3v12" />,
        props
    )
}

/** Source-session shortcut used by Kanban task cards. */
export function SessionIcon(props: IconProps) {
    return createIcon(
        <>
            <path d="M20.25 12c0 4.556-3.694 8.25-8.25 8.25a8.21 8.21 0 0 1-3.85-.954L3.75 20.25l.954-4.4A8.21 8.21 0 0 1 3.75 12C3.75 7.444 7.444 3.75 12 3.75S20.25 7.444 20.25 12Z" />
            <path d="M8.25 12h.008v.008H8.25V12Zm3.75 0h.008v.008H12V12Zm3.75 0h.008v.008H15.75V12Z" strokeWidth="2.5" />
        </>,
        props,
        1.8
    )
}

export function PlusCircleIcon(props: IconProps) {
    return createIcon(
        <path d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
        props
    )
}

export function CopyIcon(props: IconProps) {
    return createIcon(
        <>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>,
        props,
        2
    )
}

export function CheckIcon(props: IconProps) {
    return createIcon(
        <polyline points="20 6 9 17 4 12" />,
        props,
        2
    )
}

export function ArrowDownIcon(props: IconProps) {
    return createIcon(
        <path d="M12 5v14m7-7-7 7-7-7" />,
        props,
        2
    )
}

export function ArrowRightIcon(props: IconProps) {
    return createIcon(
        <path d="M5 12h14m-7-7 7 7-7 7" />,
        props,
        2
    )
}

/** Composer schedule-send clock — circle + hands (matches ComposerButtons). */
export function ScheduleIcon(props: IconProps) {
    return createIcon(
        <>
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15.5 14" />
        </>,
        props,
        2
    )
}
