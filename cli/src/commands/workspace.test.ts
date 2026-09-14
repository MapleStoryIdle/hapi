import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userInfo } from 'node:os'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'

const mocks = vi.hoisted(() => ({
    configuration: {
        apiUrl: 'https://hub.example.test',
        _setApiUrl(url: string) { this.apiUrl = url }
    },
    initializeApiUrl: vi.fn(async () => 'settings'),
    updateSettings: vi.fn(),
    registerWorkspace: vi.fn()
}))

vi.mock('@/configuration', () => ({ configuration: mocks.configuration }))
vi.mock('@/ui/apiUrlInit', () => ({ initializeApiUrl: mocks.initializeApiUrl }))
vi.mock('@/persistence', () => ({ updateSettings: mocks.updateSettings }))
vi.mock('@/authV2/client', () => ({ registerWorkspace: mocks.registerWorkspace }))

import { handleWorkspaceCommand } from './workspace'

describe('workspace register', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.configuration.apiUrl = 'https://hub.example.test'
        mocks.registerWorkspace.mockResolvedValue({
            workspace: { id: 'w1', name: 'Home', dataNamespace: 'n1', createdAt: 1 }
        })
    })

    it('generates the one-time spw credential locally', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await handleWorkspaceCommand(['register', 'Home'])

            expect(mocks.registerWorkspace).toHaveBeenCalledWith(
                'https://hub.example.test',
                { name: 'Home', webToken: expect.stringMatching(/^spw[A-Za-z0-9_-]{43}$/) },
                undefined
            )
            const token = mocks.registerWorkspace.mock.calls[0]![1].webToken
            expect(output).toHaveBeenCalledWith(token)
        } finally {
            output.mockRestore()
        }
    })

    it('writes the generated credential to a private installer handoff file', async () => {
        const root = mkdtempSync(join(tmpdir(), 'shapi-workspace-test-'))
        const path = join(root, 'spw')
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await handleWorkspaceCommand(['register', '--output-token-file', path])
            expect(await readFile(path, 'utf8')).toMatch(/^spw[A-Za-z0-9_-]{43}\n$/)
        } finally {
            output.mockRestore()
            await rm(root, { recursive: true, force: true })
        }
    })

    it('uses the system username when the workspace name is omitted', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await handleWorkspaceCommand(['register'])

            expect(mocks.registerWorkspace).toHaveBeenCalledWith(
                'https://hub.example.test',
                expect.objectContaining({ name: userInfo().username.slice(0, 64) }),
                undefined
            )
        } finally {
            output.mockRestore()
        }
    })

    it('accepts an optional named workspace flag', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await handleWorkspaceCommand(['register', '--hub', 'https://install.example.test', '--name', 'Alice'])

            expect(mocks.registerWorkspace).toHaveBeenCalledWith(
                'https://install.example.test',
                expect.objectContaining({ name: 'Alice' }),
                undefined
            )
        } finally {
            output.mockRestore()
        }
    })

    it('uses and saves the explicit installation Hub URL', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        mocks.updateSettings.mockImplementation(async updater => updater({ keep: true }))
        try {
            await handleWorkspaceCommand(['register', 'Home', '--hub', 'https://install.example.test/'])

            expect(mocks.registerWorkspace).toHaveBeenCalledWith(
                'https://install.example.test',
                expect.objectContaining({ name: 'Home' }),
                undefined
            )
            expect(mocks.configuration.apiUrl).toBe('https://install.example.test')
        } finally {
            output.mockRestore()
        }
    })

    it('sends the enrollment secret with either flag order', async () => {
        const output = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await handleWorkspaceCommand([
                'register',
                'Home',
                '--registration-secret',
                'join-secret',
                '--hub',
                'https://install.example.test/'
            ])

            expect(mocks.registerWorkspace).toHaveBeenCalledWith(
                'https://install.example.test',
                expect.objectContaining({ name: 'Home' }),
                'join-secret'
            )
        } finally {
            output.mockRestore()
        }
    })
})
