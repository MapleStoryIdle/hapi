import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import {
    formatTerminalOutput,
    formatTerminalExecutionDuration,
    getTerminalExecutionDetails,
    getTerminalExecutionState,
    isTerminalExecutionTool
} from '@/components/ToolCard/terminalExecution'

function makeBlock(result: unknown, input: unknown = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'terminal-1',
        localId: null,
        createdAt: 100,
        children: [],
        tool: {
            id: 'terminal-1',
            name: 'CodexBash',
            state: 'completed',
            input,
            result,
            createdAt: 100,
            startedAt: 200,
            completedAt: 1_450,
            description: null
        }
    }
}

describe('terminal execution details', () => {
    it('keeps the command, environment, output, error, exit code, and duration together', () => {
        const block = makeBlock({
            stdout: 'running tests\\n',
            error: 'one test failed\\n',
            exit_code: 1,
            status: 'failed'
        }, {
            command: '/bin/zsh -lc "bun test"',
            cwd: '/workspace/hapi'
        })

        expect(getTerminalExecutionDetails(block)).toEqual({
            command: '/bin/zsh -lc "bun test"',
            cwd: '/workspace/hapi',
            stdout: 'running tests\\n',
            stderr: 'one test failed\\n',
            exitCode: 1,
            status: 'failed',
            durationMs: 1_250
        })
        expect(getTerminalExecutionState(block)).toBe('failed')
    })

    it('keeps a failed command failed when the agent did not return stdout or stderr', () => {
        const block = makeBlock({
            command: '/bin/zsh -lc "ls /definitely-not-exists"',
            cwd: '/workspace/hapi',
            exit_code: 1,
            status: 'failed'
        })

        expect(getTerminalExecutionDetails(block)).toMatchObject({
            command: '/bin/zsh -lc "ls /definitely-not-exists"',
            cwd: '/workspace/hapi',
            stdout: null,
            stderr: null,
            exitCode: 1,
            status: 'failed'
        })
        expect(getTerminalExecutionState(block)).toBe('failed')
    })

    it('prefers the duration recorded by the CLI over message arrival timestamps', () => {
        const block = makeBlock({ stdout: 'ok' })
        block.tool.durationMs = 4_250
        block.tool.completedAt = 250

        expect(getTerminalExecutionDetails(block).durationMs).toBe(4_250)
    })

    it('reads legacy Codex command output without changing its status', () => {
        const block = makeBlock('Exit code: 0\nWall time: 0.1s\nOutput:\nok', {
            command: ['/bin/zsh', '-lc', 'pwd']
        })

        expect(getTerminalExecutionDetails(block)).toMatchObject({
            command: '/bin/zsh -lc pwd',
            stdout: 'ok',
            stderr: null,
            exitCode: 0,
            status: null
        })
        expect(getTerminalExecutionState(block)).toBe('completed')
    })

    it('unwraps the exec result envelope and keeps only its output', () => {
        const block = makeBlock({
            stdout: JSON.stringify({
                chunk_id: 'chunk-1',
                wall_time_seconds: 2.1,
                exit_code: 0,
                original_token_count: 12,
                output: '{"ok":true}'
            })
        })

        expect(getTerminalExecutionDetails(block).stdout).toBe('{"ok":true}')
        expect(formatTerminalOutput(getTerminalExecutionDetails(block).stdout!)).toEqual({
            text: '{\n  "ok": true\n}',
            language: 'json'
        })
    })

    it('does not unwrap ordinary JSON objects that happen to contain output', () => {
        const value = '{"name":"report","output":"kept"}'
        expect(getTerminalExecutionDetails(makeBlock({ stdout: value })).stdout).toBe(value)
    })

    it('pretty prints wrapped, ANSI-colored, fenced, and JSON Lines output', () => {
        expect(formatTerminalOutput('"{\\"ok\\":true,\\"items\\":[1,2]}"')).toEqual({
            text: '{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}',
            language: 'json'
        })
        expect(formatTerminalOutput('\u001b[32m{"ok":true}\u001b[0m')).toEqual({
            text: '{\n  "ok": true\n}',
            language: 'json'
        })
        expect(formatTerminalOutput('```json\n{"ok":true}\n```')).toEqual({
            text: '{\n  "ok": true\n}',
            language: 'json'
        })
        expect(formatTerminalOutput('{"id":1}\n{"id":2}')).toEqual({
            text: '{\n  "id": 1\n}\n\n{\n  "id": 2\n}',
            language: 'json'
        })
    })

    it('identifies only shell-like tools and formats readable durations', () => {
        expect(isTerminalExecutionTool('CodexBash')).toBe(true)
        expect(isTerminalExecutionTool('shell_command')).toBe(true)
        expect(isTerminalExecutionTool('Read')).toBe(false)
        expect(formatTerminalExecutionDuration(1_250)).toBe('1.3s')
        expect(formatTerminalExecutionDuration(65_000)).toBe('1m 5s')
    })
})
