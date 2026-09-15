import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    configuration: {
        apiUrl: 'https://hub.example.test',
        cliApiToken: '',
        _setCliApiToken(token: string) { this.cliApiToken = token }
    },
    initializeApiUrl: vi.fn(async () => 'settings'),
    readSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (updater: (value: Record<string, unknown>) => Record<string, unknown>) => updater({})),
    readRunnerCredential: vi.fn(),
    exportHapiHubApiUrl: vi.fn()
}))

vi.mock('@/configuration', () => ({ configuration: mocks.configuration }))
vi.mock('@/ui/apiUrlInit', () => ({ initializeApiUrl: mocks.initializeApiUrl }))
vi.mock('@/persistence', () => ({ readSettings: mocks.readSettings, updateSettings: mocks.updateSettings }))
vi.mock('@/authV2/credentials', () => ({ readRunnerCredential: mocks.readRunnerCredential }))
vi.mock('@/agent/hapiSessionEnv', () => ({ exportHapiHubApiUrl: mocks.exportHapiHubApiUrl }))

import { initializeToken } from './tokenInit'

describe('initializeToken auth-v2', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.configuration.cliApiToken = ''
        mocks.readSettings.mockResolvedValue({ machineId: 'old-machine' })
    })

    it('loads an approved per-Hub runner credential before a legacy settings token', async () => {
        mocks.readSettings.mockResolvedValue({ machineId: 'old-machine', cliApiToken: 'legacy-token' })
        mocks.readRunnerCredential.mockResolvedValue({
            status: 'approved',
            runnerToken: `spr${'a'.repeat(43)}`,
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
        })

        await initializeToken()

        expect(mocks.configuration.cliApiToken).toBe(`spr${'a'.repeat(43)}`)
        expect(mocks.updateSettings).toHaveBeenCalledOnce()
        expect(mocks.updateSettings.mock.calls[0]![0]({ machineId: 'old-machine' })).toEqual({
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
        })
        expect(mocks.exportHapiHubApiUrl).toHaveBeenCalledWith({ exportApiUrl: true })
    })
})
