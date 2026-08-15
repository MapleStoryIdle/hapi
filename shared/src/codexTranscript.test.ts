import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLocalCodexSessionData } from './codexTranscript'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
    if (originalCodexHome === undefined) {
        delete process.env.CODEX_HOME
    } else {
        process.env.CODEX_HOME = originalCodexHome
    }
})

describe('getLocalCodexSessionData', () => {
    it('keeps heartbeat timestamps from the trigger for its final status response', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-codex-heartbeat-test-'))
        const sessionId = '99999999-9999-4999-8999-999999999999'
        const heartbeatTime = '2026-08-15T00:54:47.781Z'
        const sessionDir = join(codexHome, 'sessions', '2026', '08', '15')
        mkdirSync(sessionDir, { recursive: true })
        const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, `${[
            { type: 'session_meta', payload: { id: sessionId, cwd: '/workspace/project' } },
            {
                // Codex's line timestamp can be written much later than the
                // automation trigger, so the embedded heartbeat time wins.
                timestamp: '2026-08-15T03:00:00.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: `<heartbeat><automation_id>bug</automation_id><current_time_iso>${heartbeatTime}</current_time_iso><instructions>自动改bug</instructions></heartbeat>` }]
                }
            },
            {
                timestamp: '2026-08-15T03:00:05.000Z',
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: '<heartbeat><automation_id>bug</automation_id><decision>DONT_NOTIFY</decision><message>No new bugs.</message></heartbeat>' }]
                }
            }
        ].map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8')
        process.env.CODEX_HOME = codexHome

        try {
            const data = getLocalCodexSessionData(sessionId, { limit: 50 })
            expect(data?.importedMessages.map((message) => message.createdAt)).toEqual([
                Date.parse(heartbeatTime),
                Date.parse(heartbeatTime)
            ])
        } finally {
            rmSync(codexHome, { recursive: true, force: true })
        }
    })
})
