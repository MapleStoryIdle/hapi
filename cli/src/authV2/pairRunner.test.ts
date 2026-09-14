import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    configuration: {
        apiUrl: 'https://hub.example.test',
        cliApiToken: '',
        _setApiUrl(url: string) { this.apiUrl = url },
        _setCliApiToken(token: string) { this.cliApiToken = token }
    },
    initializeApiUrl: vi.fn(async () => 'settings'),
    readSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (updater: (value: Record<string, unknown>) => Record<string, unknown>) => updater({})),
    readRunnerCredential: vi.fn(),
    writeRunnerCredential: vi.fn(async (_credential: unknown) => {}),
    approveRunnerDeviceAuthorizationWithWebToken: vi.fn(async () => {}),
    createRunnerDeviceAuthorization: vi.fn(),
    pollRunnerDeviceAuthorization: vi.fn()
}))

vi.mock('@/configuration', () => ({ configuration: mocks.configuration }))
vi.mock('@/ui/apiUrlInit', () => ({ initializeApiUrl: mocks.initializeApiUrl }))
vi.mock('@/persistence', () => ({ readSettings: mocks.readSettings, updateSettings: mocks.updateSettings }))
vi.mock('./client', () => ({
    approveRunnerDeviceAuthorizationWithWebToken: mocks.approveRunnerDeviceAuthorizationWithWebToken,
    createRunnerDeviceAuthorization: mocks.createRunnerDeviceAuthorization,
    pollRunnerDeviceAuthorization: mocks.pollRunnerDeviceAuthorization
}))
vi.mock('./credentials', async importOriginal => {
    const actual = await importOriginal<typeof import('./credentials')>()
    return {
        ...actual,
        generateRunnerKeyMaterial: () => ({
            runnerToken: `spr${'a'.repeat(43)}`,
            publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
            privateJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' },
            publicKeyThumbprint: 'b'.repeat(43)
        }),
        readRunnerCredential: mocks.readRunnerCredential,
        writeRunnerCredential: mocks.writeRunnerCredential
    }
})

import { pairRunner, parseRunnerPairArgs } from './pairRunner'

describe('pairRunner', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.configuration.cliApiToken = ''
        mocks.readRunnerCredential.mockResolvedValue(null)
        mocks.createRunnerDeviceAuthorization.mockResolvedValue({
            deviceCode: 'd'.repeat(43),
            userCode: '0123ABCD',
            verificationUri: 'https://hub.example.test/pair',
            expiresIn: 600,
            interval: 5
        })
    })

    it('persists pending secrets before polling and replaces them after approval', async () => {
        mocks.pollRunnerDeviceAuthorization
            .mockResolvedValueOnce({ status: 'pending' })
            .mockResolvedValueOnce({
                status: 'approved',
                workspaceId: 'w1',
                accessKeyId: 'k1',
                machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
            })
        mocks.readSettings.mockResolvedValue({ machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb' })
        const sleeps: number[] = []
        const output = vi.fn()

        const credential = await pairRunner({
            displayName: 'Desk',
            now: () => 1_000,
            sleep: async milliseconds => { sleeps.push(milliseconds) },
            output
        })

        expect(mocks.createRunnerDeviceAuthorization).toHaveBeenCalledWith(
            'https://hub.example.test',
            expect.objectContaining({
                runnerToken: `spr${'a'.repeat(43)}`,
                displayName: 'Desk',
                machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
            }),
            expect.any(Function)
        )
        expect(mocks.writeRunnerCredential).toHaveBeenCalledTimes(2)
        expect(mocks.writeRunnerCredential.mock.calls[0]![0]).toMatchObject({
            status: 'pending',
            pollIntervalMs: 5_000,
            deviceCode: 'd'.repeat(43),
            userCode: '0123ABCD'
        })
        expect(mocks.writeRunnerCredential.mock.calls[1]![0]).toMatchObject({
            status: 'approved', workspaceId: 'w1', accessKeyId: 'k1'
        })
        expect(sleeps).toEqual([5_000, 5_000])
        expect(mocks.configuration.cliApiToken).toBe(credential.runnerToken)
        expect(output).toHaveBeenCalledWith('Open: https://hub.example.test/pair')
        expect(output).toHaveBeenCalledWith('Enter code: 0123ABCD')
    })

    it('approves immediately with a supplied spw credential', async () => {
        mocks.pollRunnerDeviceAuthorization.mockResolvedValue({
            status: 'approved',
            workspaceId: 'w1',
            accessKeyId: 'k1',
            machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb'
        })
        mocks.readSettings.mockResolvedValue({ machineId: '86fbf20a-88cc-438d-80b2-3f5039f833eb' })
        const sleep = vi.fn(async () => {})

        await pairRunner({ webToken: `spw${'w'.repeat(43)}`, sleep })

        expect(mocks.approveRunnerDeviceAuthorizationWithWebToken).toHaveBeenCalledWith(
            'https://hub.example.test',
            '0123ABCD',
            `spw${'w'.repeat(43)}`,
            expect.any(Function)
        )
        expect(sleep).not.toHaveBeenCalled()
    })

    it('does not replace an existing approved identity', async () => {
        mocks.readRunnerCredential.mockResolvedValue({ status: 'approved' })

        await expect(pairRunner()).rejects.toThrow('already paired')
        expect(mocks.createRunnerDeviceAuthorization).not.toHaveBeenCalled()
    })
})

describe('parseRunnerPairArgs', () => {
    it('accepts the installation page --hub command in either flag order', () => {
        expect(parseRunnerPairArgs(['--hub', 'https://hub.example.test', '--name', 'Desk'])).toEqual({
            hubUrl: 'https://hub.example.test',
            displayName: 'Desk'
        })
        expect(parseRunnerPairArgs(['--name', 'Desk', '--hub', 'https://hub.example.test'])).toEqual({
            displayName: 'Desk',
            hubUrl: 'https://hub.example.test'
        })
        expect(parseRunnerPairArgs(['--hub', 'https://hub.example.test', '--web-token-file', '/tmp/spw'])).toEqual({
            hubUrl: 'https://hub.example.test',
            webTokenFile: '/tmp/spw'
        })
    })
})
