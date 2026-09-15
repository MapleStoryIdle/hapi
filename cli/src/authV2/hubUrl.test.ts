import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    configuration: {
        apiUrl: 'https://old.example.test',
        _setApiUrl(url: string) { this.apiUrl = url }
    },
    initializeApiUrl: vi.fn(async () => 'settings'),
    updateSettings: vi.fn(async (updater: (value: Record<string, unknown>) => Record<string, unknown>) => updater({ keep: true }))
}))

vi.mock('@/configuration', () => ({ configuration: mocks.configuration }))
vi.mock('@/ui/apiUrlInit', () => ({ initializeApiUrl: mocks.initializeApiUrl }))
vi.mock('@/persistence', () => ({ updateSettings: mocks.updateSettings }))

import { resolveAuthV2HubUrl } from './hubUrl'

describe('resolveAuthV2HubUrl', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.configuration.apiUrl = 'https://old.example.test'
    })

    it('validates and saves an explicitly selected Hub', async () => {
        await expect(resolveAuthV2HubUrl('https://new.example.test/')).resolves.toBe('https://new.example.test')
        expect(mocks.configuration.apiUrl).toBe('https://new.example.test')
        expect(mocks.updateSettings.mock.calls[0]![0]({ keep: true })).toEqual({
            keep: true,
            apiUrl: 'https://new.example.test'
        })
        expect(mocks.initializeApiUrl).not.toHaveBeenCalled()
    })
})
