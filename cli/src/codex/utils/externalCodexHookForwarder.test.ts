import { describe, expect, it } from 'vitest'
import {
    parseExternalCodexHookForwarderOptions,
    parseExternalCodexHookRequest,
    parseExternalCodexLifecycleHookEvent,
    parseExternalCodexLifecycleHookForwarderOptions
} from './externalCodexHookForwarder'

describe('external Codex hook forwarder', () => {
    it('parses the generated hook-forwarder flags', () => {
        expect(parseExternalCodexHookForwarderOptions([
            '--external-codex-request',
            '--kind',
            'permission',
            '--runner-state',
            '/tmp/hapi-runner.state.json'
        ])).toEqual({
            kind: 'permission',
            phase: 'requested',
            runnerStatePath: '/tmp/hapi-runner.state.json'
        })
        expect(parseExternalCodexLifecycleHookForwarderOptions([
            '--external-codex-lifecycle',
            '--runner-state',
            '/tmp/hapi-runner.state.json'
        ])).toEqual({ runnerStatePath: '/tmp/hapi-runner.state.json' })
    })

    it('reduces a permission hook to non-sensitive routing metadata', () => {
        expect(parseExternalCodexHookRequest('permission', {
            session_id: 'codex-session-1',
            turn_id: 'turn-1',
            tool_use_id: 'tool-use-1',
            tool_name: 'Bash',
            tool_input: { command: 'contains-a-secret-and-must-not-leave-the-machine' }
        }, () => 100)).toEqual({
            codexSessionId: 'codex-session-1',
            requestId: 'tool-use-1',
            kind: 'permission',
            phase: 'requested',
            toolName: 'Bash',
            turnId: 'turn-1',
            observedAt: 100
        })
    })

    it('uses the turn and tool as a stable request identity when a hook has no tool-use id', () => {
        expect(parseExternalCodexHookRequest('user-input', {
            session_id: 'codex-session-2',
            turn_id: 'turn-2',
            tool_name: 'request_user_input'
        }, () => 200)).toEqual({
            codexSessionId: 'codex-session-2',
            requestId: 'turn-2:request_user_input',
            kind: 'user-input',
            phase: 'requested',
            toolName: 'request_user_input',
            turnId: 'turn-2',
            observedAt: 200
        })
    })

    it('marks a PostToolUse user-input hook as resolved without forwarding its output', () => {
        expect(parseExternalCodexHookForwarderOptions([
            '--external-codex-request', '--kind', 'user-input', '--phase', 'resolved', '--runner-state', '/tmp/state'
        ])).toEqual({ kind: 'user-input', phase: 'resolved', runnerStatePath: '/tmp/state' })
        const request = parseExternalCodexHookRequest('user-input', {
            session_id: 'codex-session-2', tool_use_id: 'call-1', tool_response: { answer: 'private' }
        }, () => 300, 'resolved')
        expect(request).toMatchObject({ requestId: 'call-1', phase: 'resolved', observedAt: 300 })
        expect(JSON.stringify(request)).not.toContain('private')
    })

    it('reduces UserPromptSubmit to local lifecycle metadata without prompt fields', () => {
        const event = parseExternalCodexLifecycleHookEvent({
            session_id: 'codex-session-3',
            turn_id: 'turn-3',
            prompt: 'TOP_SECRET',
            cwd: '/private/workspace',
            model: 'private-model',
            transcript_path: '/private/transcript.jsonl'
        }, () => 1_725_000_000_000)

        expect(event).toEqual({
            codexSessionId: 'codex-session-3',
            turnId: 'turn-3',
            event: 'turn_started',
            observedAt: 1_725_000_000_000
        })
        expect(JSON.stringify(event)).not.toContain('TOP_SECRET')
        expect(JSON.stringify(event)).not.toContain('/private')
    })

    it('ignores malformed hook payloads', () => {
        expect(parseExternalCodexHookRequest('permission', { tool_name: 'Bash' })).toBeNull()
        expect(parseExternalCodexHookForwarderOptions(['--external-codex-request', '--kind', 'bad'])).toBeNull()
        expect(parseExternalCodexLifecycleHookEvent({ session_id: 'codex-session-4' })).toBeNull()
    })
})
