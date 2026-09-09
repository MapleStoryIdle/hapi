export function MonitorEnabledSwitch(props: { enabled: boolean; disabled?: boolean; label: string; onChange: (enabled: boolean) => void }) {
    return <label className="relative flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-2 text-sm font-medium">
        <span className="min-w-0 break-words">{props.label}</span>
        <input type="checkbox" role="switch" checked={props.enabled} disabled={props.disabled} onChange={event => props.onChange(event.target.checked)} className="peer sr-only" />
        <span aria-hidden="true" className="relative h-7 w-12 shrink-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-emerald-500 peer-disabled:opacity-50 peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--app-link)] after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5 motion-reduce:transition-none motion-reduce:after:transition-none" />
    </label>
}
