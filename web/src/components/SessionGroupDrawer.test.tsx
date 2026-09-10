import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionGroupDrawer } from './SessionGroupDrawer'
import { resolveSessionGroup, sessionGroupsClientKey } from '@/hooks/useSessionGroups'

vi.mock('@/components/ui/BottomDrawer', () => ({ BottomDrawer: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <div>{children}</div> : null }))
afterEach(cleanup)

const group = { id: 'g1', name: 'Release', emoji: '🚀' }
const source = { type: 'managed' as const, sessionId: 's1' }

function setup(assignment = vi.fn().mockResolvedValue({ ok: true })) {
    localStorage.setItem('hapi-lang', 'en')
    const api = {
        getSessionGroups: vi.fn().mockResolvedValue({ groups: [group], assignments: [] }),
        createSessionGroup: vi.fn().mockResolvedValue({ group }),
        updateSessionGroup: vi.fn().mockResolvedValue({ group }),
        assignSessionGroup: assignment
    }
    const onOpenChange = vi.fn()
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><SessionGroupDrawer api={api as unknown as ApiClient} source={source} open onOpenChange={onOpenChange} /></I18nProvider>
    </QueryClientProvider>)
    return { api, onOpenChange }
}

describe('session group selection', () => {
    it('isolates cached groups between authenticated clients without token keys', () => {
        const first = {} as ApiClient
        const second = {} as ApiClient
        expect(sessionGroupsClientKey(first)).toEqual(sessionGroupsClientKey(first))
        expect(sessionGroupsClientKey(first)).not.toEqual(sessionGroupsClientKey(second))
        expect(sessionGroupsClientKey(null)).not.toEqual(sessionGroupsClientKey(first))
    })
    it('assigns an existing group with one tap and allows no group', async () => {
        const { api, onOpenChange } = setup()
        fireEvent.click(await screen.findByRole('button', { name: 'Release' }))
        await waitFor(() => expect(api.assignSessionGroup).toHaveBeenCalledWith(source, 'g1'))
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
        fireEvent.click(screen.getByRole('button', { name: 'No group' }))
        await waitFor(() => expect(api.assignSessionGroup).toHaveBeenCalledWith(source, null))
    })

    it('creates only name and emoji, and retries assignment without creating a duplicate', async () => {
        const assignment = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true })
        const { api, onOpenChange } = setup(assignment)
        await screen.findByRole('button', { name: 'Release' })
        fireEvent.click(screen.getByRole('button', { name: 'New group' }))
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Release' } })
        fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '🚀' } })
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await screen.findByRole('alert')
        expect(onOpenChange).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
        expect(api.createSessionGroup).toHaveBeenCalledExactlyOnceWith({ name: 'Release', emoji: '🚀' })
        expect(assignment).toHaveBeenCalledTimes(2)
    })

    it('resolves native identities per machine and gives managed assignment priority', () => {
        const native = { type: 'native-codex' as const, machineId: 'a', codexSessionId: 'thread' }
        const second = { id: 'g2', name: 'Other', emoji: '🎯' }
        const data = { groups: [group, second], assignments: [{ source: native, groupId: 'g1' }] }
        expect(resolveSessionGroup(data, { ...native, machineId: 'b' })).toBeUndefined()
        expect(resolveSessionGroup(data, source, native)).toEqual(group)
        expect(resolveSessionGroup({ ...data, assignments: [...data.assignments, { source, groupId: 'g2' }] }, source, native)).toEqual(second)
    })
})
