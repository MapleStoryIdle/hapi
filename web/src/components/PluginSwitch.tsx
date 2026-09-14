export function PluginSwitch(props: {
    checked: boolean
    label: string
    disabled?: boolean
    onChange: (checked: boolean) => void
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={props.checked}
            aria-label={props.label}
            disabled={props.disabled}
            onClick={() => props.onChange(!props.checked)}
            className="relative flex h-11 w-[51px] min-w-[51px] shrink-0 touch-manipulation items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-45"
        >
            <span className={`relative block h-[31px] w-[51px] rounded-full transition-colors duration-200 ${props.checked ? 'bg-emerald-500' : 'bg-[var(--app-border)]'}`}>
                <span className={`absolute left-0.5 top-0.5 h-[27px] w-[27px] rounded-full bg-white shadow transition-transform duration-200 ${props.checked ? 'translate-x-5' : 'translate-x-0'}`} />
            </span>
        </button>
    )
}
