import { describe, expect, it } from 'vitest'
import { HAPI_CLI_CAPABILITIES, getHapiCliCommandCapabilities } from './capabilities'

describe('HAPI CLI machine-readable capabilities', () => {
    it('声明原生 Codex fork 与 A2A peer 工具', () => {
        expect(HAPI_CLI_CAPABILITIES.commands.codex.subcommands.fork).toMatchObject({
            args: ['sourceSessionId'],
            sourceRunnerAffinity: 'selected_runner_owns_transcript',
            localTranscriptRpc: true
        })
        expect(HAPI_CLI_CAPABILITIES.commands.mcp.tools).toEqual(expect.arrayContaining([
            'list_peers',
            'inspect_peer',
            'ping_peer'
        ]))
        expect(getHapiCliCommandCapabilities('ping-peer')).toMatchObject({
            command: 'ping-peer',
            sideEffects: 'resume_target_and_send_message',
            rejectsCallerSession: true
        })
        expect(HAPI_CLI_CAPABILITIES.commands.share).toMatchObject({
            subcommands: {
                publish: { args: ['relativeFile'], options: ['--expires'] },
                revoke: { args: ['shareId'] }
            },
            sideEffects: 'upload_selected_local_file'
        })
        expect(HAPI_CLI_CAPABILITIES.commands).not.toHaveProperty('artifact')
    })
})
