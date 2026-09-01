import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    buildExternalCodexNotificationHookCommand,
    installExternalCodexNotificationHooks
} from './externalCodexNotificationHooks'

describe('installExternalCodexNotificationHooks', () => {
    let directory: string
    let hooksPath: string

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'hapi-codex-hooks-'))
        hooksPath = join(directory, 'hooks.json')
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    it('builds a separate lifecycle forwarder command', () => {
        const command = buildExternalCodexNotificationHookCommand('turn-started', '/tmp/runner.state.json')
        expect(command).toContain('--external-codex-lifecycle')
        expect(command).toMatch(/--runner-state\s+"?\/tmp\/runner\.state\.json"?/)
        expect(command).not.toContain('--external-codex-request')
    })

    it('adds permission, structured-input, and turn-start hooks without replacing existing hooks', async () => {
        await writeFile(hooksPath, JSON.stringify({
            description: 'Existing hooks',
            hooks: {
                Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'existing-stop-hook' }] }],
                PermissionRequest: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'existing-permission-hook' }] }],
                PreToolUse: [{ matcher: '^Write$', hooks: [{ type: 'command', command: 'existing-pre-tool-hook' }] }]
            }
        }, null, 2))

        const result = await installExternalCodexNotificationHooks({
            hooksPath,
            runnerStatePath: '/tmp/runner.state.json',
            commandForKind: (kind) => kind === 'turn-started'
                ? 'hapi hook-forwarder --external-codex-lifecycle'
                : `hapi hook-forwarder --external-codex-request --kind ${kind}`
        })

        expect(result).toEqual({
            hooksPath,
            addedKinds: ['permission', 'user-input', 'turn-started']
        })

        const written = JSON.parse(await readFile(hooksPath, 'utf-8')) as {
            hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
        }
        expect(written.hooks.Stop).toHaveLength(1)
        expect(written.hooks.PermissionRequest).toEqual([
            { matcher: '^Bash$', hooks: [{ type: 'command', command: 'existing-permission-hook' }] },
            {
                matcher: '*',
                hooks: [{
                    type: 'command',
                    command: 'hapi hook-forwarder --external-codex-request --kind permission',
                    timeout: 10
                }]
            }
        ])
        expect(written.hooks.PreToolUse).toEqual([
            { matcher: '^Write$', hooks: [{ type: 'command', command: 'existing-pre-tool-hook' }] },
            {
                matcher: '^request_user_input$',
                hooks: [{
                    type: 'command',
                    command: 'hapi hook-forwarder --external-codex-request --kind user-input',
                    timeout: 10
                }]
            }
        ])
        expect(written.hooks.UserPromptSubmit).toEqual([{
            hooks: [{
                type: 'command',
                command: 'hapi hook-forwarder --external-codex-lifecycle',
                timeout: 10
            }]
        }])
        expect(written.hooks.SessionEnd).toBeUndefined()
    })

    it('migrates existing HAPI hooks that use unsupported async execution', async () => {
        await writeFile(hooksPath, JSON.stringify({
            hooks: {
                PermissionRequest: [{
                    matcher: '*',
                    hooks: [{
                        type: 'command',
                        command: 'hapi hook-forwarder --external-codex-request --kind permission',
                        async: true,
                        timeout: 10
                    }]
                }],
                PreToolUse: [{
                    matcher: '^request_user_input$',
                    hooks: [{
                        type: 'command',
                        command: 'hapi hook-forwarder --external-codex-request --kind user-input',
                        async: true,
                        timeout: 10
                    }]
                }]
            }
        }, null, 2))

        const result = await installExternalCodexNotificationHooks({
            hooksPath,
            commandForKind: (kind) => kind === 'turn-started'
                ? 'hapi hook-forwarder --external-codex-lifecycle'
                : `hapi hook-forwarder --external-codex-request --kind ${kind}`
        })

        expect(result.addedKinds).toEqual(['turn-started'])
        const written = JSON.parse(await readFile(hooksPath, 'utf-8')) as {
            hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>
        }
        expect(written.hooks.PermissionRequest[0].hooks[0]).toEqual({
            type: 'command',
            command: 'hapi hook-forwarder --external-codex-request --kind permission',
            timeout: 10
        })
        expect(written.hooks.PreToolUse[0].hooks[0]).toEqual({
            type: 'command',
            command: 'hapi hook-forwarder --external-codex-request --kind user-input',
            timeout: 10
        })
        expect(written.hooks.UserPromptSubmit).toEqual([{
            hooks: [{
                type: 'command',
                command: 'hapi hook-forwarder --external-codex-lifecycle',
                timeout: 10
            }]
        }])
    })

    it('is idempotent when HAPI hooks already exist', async () => {
        const options = {
            hooksPath,
            commandForKind: (kind: 'permission' | 'user-input' | 'turn-started') => kind === 'turn-started'
                ? 'hapi hook-forwarder --external-codex-lifecycle'
                : `hapi hook-forwarder --external-codex-request --kind ${kind}`
        }
        await installExternalCodexNotificationHooks(options)
        const before = await readFile(hooksPath, 'utf-8')

        const result = await installExternalCodexNotificationHooks(options)

        expect(result.addedKinds).toEqual([])
        expect(await readFile(hooksPath, 'utf-8')).toBe(before)
    })

    it('does not overwrite an invalid existing event configuration', async () => {
        await writeFile(hooksPath, JSON.stringify({
            hooks: { PermissionRequest: { invalid: true } }
        }))

        await expect(installExternalCodexNotificationHooks({ hooksPath })).rejects
            .toThrow('PermissionRequest in hooks.json must be an array')
    })
})
