import { useRef, type CSSProperties, type KeyboardEvent } from 'react'

/** A single compact, keyboard-accessible segmented control for detail sheets. */
export function ChatDetailTabs<T extends string>(props: {
    tabs: readonly { value: T; label: string }[]
    value: T
    onChange: (value: T) => void
    idPrefix: string
    label: string
}) {
    const refs = useRef<Array<HTMLButtonElement | null>>([])
    const selected = props.tabs.findIndex((tab) => tab.value === props.value)
    function onKeyDown(event: KeyboardEvent, index: number) {
        const count = props.tabs.length
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? count - 1
            : event.key === 'ArrowRight' ? (index + 1) % count
                : event.key === 'ArrowLeft' ? (index - 1 + count) % count : null
        if (next === null) return
        event.preventDefault()
        props.onChange(props.tabs[next].value)
        refs.current[next]?.focus()
    }
    return (
        <div className="chat-segmented chat-detail-tabs" role="tablist" aria-label={props.label}
            style={{ '--chat-tab-count': props.tabs.length, '--chat-tab-index': selected } as CSSProperties}>
            {props.tabs.map((tab, index) => (
                <button key={tab.value} ref={(element) => { refs.current[index] = element }}
                    type="button" role="tab" className="chat-segment"
                    id={`${props.idPrefix}-tab-${tab.value}`} aria-controls={`${props.idPrefix}-panel-${tab.value}`}
                    aria-selected={props.value === tab.value} tabIndex={props.value === tab.value ? 0 : -1}
                    onClick={() => props.onChange(tab.value)} onKeyDown={(event) => onKeyDown(event, index)}>
                    {tab.label}
                </button>
            ))}
        </div>
    )
}
