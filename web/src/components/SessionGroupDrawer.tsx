import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus } from 'lucide-react'
import type { ApiClient } from '@/api/client'
import type { SessionGroup, SessionGroupSource } from '@hapi/protocol/sessionGroups'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { resolveSessionGroup, sessionGroupSourceKey, sessionGroupsQueryKey, useSessionGroups } from '@/hooks/useSessionGroups'
import { useTranslation } from '@/lib/use-translation'

export function SessionGroupDrawer(props: {
    api: ApiClient | null
    source: SessionGroupSource
    nativeAlias?: SessionGroupSource | null
    open: boolean
    onOpenChange: (open: boolean) => void
}) {
    const { t } = useTranslation()
    const query = useSessionGroups(props.api)
    const client = useQueryClient()
    const current = resolveSessionGroup(query.data, props.source, props.nativeAlias)
    const [editing, setEditing] = useState<SessionGroup | 'new' | null>(null)
    const [name, setName] = useState('')
    const [emoji, setEmoji] = useState('📁')
    const [busy, setBusy] = useState(false)
    const [createdGroupId, setCreatedGroupId] = useState<string | null>(null)
    const [error, setError] = useState(false)
    const rowClass = 'flex min-h-11 items-center gap-3 rounded-xl px-3 text-left active:bg-[var(--app-subtle-bg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-50'

    const run = async (operation: () => Promise<void>) => {
        if (busy || !props.api) return
        setBusy(true)
        setError(false)
        try {
            await operation()
            await client.invalidateQueries({ queryKey: sessionGroupsQueryKey })
            setEditing(null)
            props.onOpenChange(false)
        } catch {
            setError(true)
        } finally {
            setBusy(false)
        }
    }
    const assign = (id: string | null) => run(async () => {
        await props.api!.assignSessionGroup(props.source, id)
        // Clear a native alias too, so removing a migrated group cannot resurrect it.
        if (props.nativeAlias && query.data?.assignments.some(item => sessionGroupSourceKey(item.source) === sessionGroupSourceKey(props.nativeAlias!))) {
            await props.api!.assignSessionGroup(props.nativeAlias, null)
        }
    })
    const edit = (group: SessionGroup | 'new') => {
        setCreatedGroupId(null)
        setEditing(group)
        setName(group === 'new' ? '' : group.name)
        setEmoji(group === 'new' ? '📁' : group.emoji)
        setError(false)
    }

    return <BottomDrawer open={props.open} busy={busy} desktopDialog inputDialog={editing !== null} onOpenChange={open => {
        if (busy) return
        props.onOpenChange(open)
        if (!open) { setEditing(null); setError(false); setCreatedGroupId(null) }
    }} title={t('session.groups.title')} density="compact" bodyClassName="space-y-3 p-4">
        {editing ? <form className="space-y-4" onSubmit={event => {
            event.preventDefault()
            void run(async () => {
                const input = { name: name.trim(), emoji: emoji.trim() }
                if (editing === 'new') {
                    const { group } = await props.api!.createSessionGroup(input)
                    // Keep the new record selected if assignment needs a retry.
                    setEditing(group)
                    setCreatedGroupId(group.id)
                    await props.api!.assignSessionGroup(props.source, group.id)
                } else {
                    await props.api!.updateSessionGroup(editing.id, input)
                    if (createdGroupId === editing.id) await props.api!.assignSessionGroup(props.source, editing.id)
                }
            })
        }}>
            <div className="flex gap-3">
                <label className="w-20 shrink-0 space-y-2 text-sm text-[var(--app-hint)]">{t('session.groups.emoji')}
                    <input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={32} required disabled={busy} className="ios-form-control h-11 w-full px-3 text-center text-base" />
                </label>
                <label className="min-w-0 flex-1 space-y-2 text-sm text-[var(--app-hint)]">{t('session.groups.name')}
                    <input data-drawer-initial-focus autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy} className="ios-form-control h-11 w-full px-3 text-base" />
                </label>
            </div>
            <div className="flex gap-3">
                <button type="button" disabled={busy} onClick={() => setEditing(null)} className={`${rowClass} flex-1 justify-center`}>{t('session.groups.cancel')}</button>
                <button type="submit" disabled={busy || !name.trim() || !emoji.trim()} className={`${rowClass} flex-1 justify-center bg-[var(--app-link)] text-white`}>{t('session.groups.save')}</button>
            </div>
        </form> : <div className="space-y-1">
            <button type="button" disabled={busy || query.isPending || query.isError} onClick={() => void assign(null)} className={`${rowClass} w-full`}>
                <span className="flex-1">{t('session.groups.none')}</span>{!current ? <Check className="h-4 w-4 text-[var(--app-link)]" /> : null}
            </button>
            {query.data?.groups.map(group => <div key={group.id} className="flex items-center gap-1">
                <button type="button" aria-pressed={current?.id === group.id} disabled={busy} onClick={() => void assign(group.id)} className={`${rowClass} min-w-0 flex-1`}>
                    <span aria-hidden="true">{group.emoji}</span><span className="min-w-0 flex-1 truncate">{group.name}</span>
                    {current?.id === group.id ? <Check className="h-4 w-4 shrink-0 text-[var(--app-link)]" /> : null}
                </button>
                <button type="button" disabled={busy} aria-label={`${t('session.groups.edit')} ${group.name}`} onClick={() => edit(group)} className={`${rowClass} justify-center`}><Pencil className="h-4 w-4" /></button>
            </div>)}
            <button type="button" disabled={busy || query.isPending || query.isError} onClick={() => edit('new')} className={`${rowClass} w-full text-[var(--app-link)]`}><Plus className="h-4 w-4" />{t('session.groups.new')}</button>
        </div>}
        {busy ? <p role="status" className="text-sm text-[var(--app-hint)]">{t('session.groups.saving')}</p> : null}
        {error || query.isError ? <div role="alert" className="text-sm text-red-500">{t('session.groups.error')}<button type="button" className={`${rowClass} mt-1`} onClick={() => void query.refetch()}>{t('session.groups.retry')}</button></div> : null}
    </BottomDrawer>
}
