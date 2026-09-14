import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionLabelSource } from '@hapi/protocol/sessionLabels'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { Button } from '@/components/ui/button'
import { getSessionLabelStyle, getSessionLabelUnits } from '@/lib/session-labels'
import { sessionGroupSourceKey } from '@/hooks/useSessionGroups'
import { sessionLabelsQueryKey } from '@/hooks/useSessionLabels'
import { useTranslation } from '@/lib/use-translation'

export function SessionLabelDialog(props: {
    api: ApiClient | null
    source: SessionLabelSource
    nativeAlias?: SessionLabelSource | null
    currentLabel?: string
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const client = useQueryClient()
    const [value, setValue] = useState(props.currentLabel ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (!props.open) return
        setValue(props.currentLabel ?? '')
        setError(false)
        const timer = window.setTimeout(() => {
            inputRef.current?.focus()
            inputRef.current?.select()
        }, 100)
        return () => window.clearTimeout(timer)
    }, [props.currentLabel, props.open])

    const save = async (event: React.FormEvent) => {
        event.preventDefault()
        if (!props.api || busy) return
        const label = value.trim() || null
        setBusy(true)
        setError(false)
        try {
            await props.api.setSessionLabel(props.source, label)
            if (props.nativeAlias && props.nativeAlias.type !== props.source.type) {
                await props.api.setSessionLabel(props.nativeAlias, null)
            } else if (props.nativeAlias && sessionGroupSourceKey(props.nativeAlias) !== sessionGroupSourceKey(props.source)) {
                await props.api.setSessionLabel(props.nativeAlias, null)
            }
            await client.invalidateQueries({ queryKey: sessionLabelsQueryKey })
            props.onOpenChange(false)
        } catch {
            setError(true)
        } finally {
            setBusy(false)
        }
    }

    return <BottomDrawer
        open={props.open}
        onOpenChange={open => { if (!busy) props.onOpenChange(open) }}
        title={t('session.labels.title')}
        inputDialog
        busy={busy}
        desktopClassName="max-w-sm"
        footer={<div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => props.onOpenChange(false)}>{t('button.cancel')}</Button>
            <Button type="submit" form="session-label-form" disabled={busy}>{busy ? t('session.labels.saving') : t('button.save')}</Button>
        </div>}
    >
        <form id="session-label-form" onSubmit={save} className="space-y-3">
            <input
                ref={inputRef}
                data-drawer-initial-focus
                value={value}
                onChange={event => {
                    if (getSessionLabelUnits(event.target.value) <= 16) setValue(event.target.value)
                }}
                placeholder={t('session.labels.placeholder')}
                className="ios-form-control h-11 w-full px-3 text-base"
                disabled={busy}
            />
            {value.trim() ? <span className="inline-flex max-w-full truncate rounded-full border px-2.5 py-1 text-xs font-medium" style={getSessionLabelStyle(value)}>{value.trim()}</span> : null}
            <p className="text-xs text-[var(--app-hint)]">{t('session.labels.limit')}</p>
            {error ? <p role="alert" className="text-sm text-red-500">{t('session.labels.error')}</p> : null}
        </form>
    </BottomDrawer>
}
