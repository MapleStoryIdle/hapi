import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'

const runtime = vi.hoisted(() => ({
    api: {
        getManagedSkills: vi.fn(),
        setManagedSkillEnabled: vi.fn(),
        cacheManagedSkill: vi.fn()
    },
    goBack: vi.fn()
}))

vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: runtime.api }) }))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => runtime.goBack }))

import SkillsPage from './skills'

beforeEach(() => {
    localStorage.setItem('hapi-lang', 'en')
    runtime.api.getManagedSkills.mockReset()
    runtime.api.setManagedSkillEnabled.mockReset().mockResolvedValue(undefined)
    runtime.api.cacheManagedSkill.mockReset().mockResolvedValue(undefined)
    runtime.api.getManagedSkills.mockResolvedValue({
        skills: [{
            id: 'public-share', name: 'Public Share', description: 'Share one file.',
            version: '1.0.0', minimumRunnerVersion: '1.1.0', sha256: 'a'.repeat(64), visibility: 'public', enabled: true,
            machines: [{
                machineId: 'runner-1', displayName: 'Mac Runner', active: true,
                runnerVersion: '1.1.0', desiredVersion: '1.0.0', installedVersion: null, state: 'missing'
            }]
        }]
    })
})

afterEach(() => {
    cleanup()
})

describe('SkillsPage', () => {
    it('shows managed Skills without Runner details and supports disabling', async () => {
        const queryClient = new QueryClient()
        render(<QueryClientProvider client={queryClient}><I18nProvider><SkillsPage /></I18nProvider></QueryClientProvider>)

        expect(await screen.findByText('Public Share')).toBeInTheDocument()
        expect(screen.getByText('Share a file or collect feedback with an expiring link.')).toBeInTheDocument()
        expect(screen.getByText('Public')).toBeInTheDocument()
        expect(screen.queryByText('Mac Runner')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('switch', { name: 'Enable or disable Public Share' }))
        await waitFor(() => expect(runtime.api.setManagedSkillEnabled).toHaveBeenCalledWith('public-share', false))

        expect(screen.queryByText('Share one file.')).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Runner online')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Cache' })).not.toBeInTheDocument()
    })

    it('uses concise Chinese copy', async () => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        render(<QueryClientProvider client={new QueryClient()}><I18nProvider><SkillsPage /></I18nProvider></QueryClientProvider>)

        expect(await screen.findByRole('heading', { name: '技能' })).toBeInTheDocument()
        expect(screen.getByText('Public Share')).toBeInTheDocument()
        expect(screen.getByText('通过限时链接分享文件或收集反馈。')).toBeInTheDocument()
        expect(screen.queryByText('Mac Runner')).not.toBeInTheDocument()
        expect(screen.queryByText(/只供 SHAPI/)).not.toBeInTheDocument()
        expect(screen.queryByText('SHAPI 管理的技能')).not.toBeInTheDocument()
    })
})
