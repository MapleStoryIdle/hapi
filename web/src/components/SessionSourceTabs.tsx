import { useRef } from 'react'
import { useTranslation } from '@/lib/use-translation'

export type SessionSource = 'running' | 'hapi' | 'codex'

type SessionSourceTabsProps = {
    value: SessionSource
    onChange: (source: SessionSource) => void
}

const SOURCES: readonly SessionSource[] = ['running', 'hapi', 'codex']

/**
 * The session list has three views, but all use the same runner and header.
 * Keep the switch a real tablist so it remains keyboard/touch friendly and
 * does not rely on the old workspace navigation affordance.
 */
export function SessionSourceTabs(props: SessionSourceTabsProps) {
    const { t } = useTranslation()
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

    const focusSource = (source: SessionSource) => {
        const index = SOURCES.indexOf(source)
        if (index < 0) return
        tabRefs.current[index]?.focus()
        props.onChange(source)
    }

    return (
        <div
            role="tablist"
            aria-label={t('sessions.sourceTabs.label')}
            className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-1 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
        >
            {SOURCES.map((source, index) => {
                const selected = props.value === source
                const label = t(`sessions.sourceTabs.${source}`)
                return (
                    <button
                        key={source}
                        ref={(element) => {
                            tabRefs.current[index] = element
                        }}
                        type="button"
                        role="tab"
                        id={`session-source-tab-${source}`}
                        aria-selected={selected}
                        aria-controls={`session-source-panel-${source}`}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => props.onChange(source)}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                                event.preventDefault()
                                focusSource(SOURCES[(index + 1) % SOURCES.length]!)
                            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                                event.preventDefault()
                                focusSource(SOURCES[(index - 1 + SOURCES.length) % SOURCES.length]!)
                            } else if (event.key === 'Home') {
                                event.preventDefault()
                                focusSource(SOURCES[0])
                            } else if (event.key === 'End') {
                                event.preventDefault()
                                focusSource(SOURCES[SOURCES.length - 1])
                            }
                        }}
                        className={`min-h-11 min-w-[3.25rem] rounded-full px-1.5 text-xs font-semibold lowercase tracking-tight transition-[background-color,color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] max-[359px]:min-w-[2.75rem] max-[359px]:px-0 max-[359px]:text-[11px] sm:min-w-[4.5rem] sm:px-3 sm:text-sm ${
                            selected
                                ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-[0_1px_4px_rgba(15,23,42,0.12)]'
                                : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                        }`}
                    >
                        {label}
                    </button>
                )
            })}
        </div>
    )
}
