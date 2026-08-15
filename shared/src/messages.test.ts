import { describe, expect, it } from 'bun:test'
import {
    isAutomationHeartbeatMessageContent,
    isMalformedAutomationHeartbeatMessageContent,
    parseAutomationHeartbeatMessageContent
} from './messages'

const heartbeat = '<heartbeat> <automation_id>bug</automation_id> <decision>DONT_NOTIFY</decision> <message>Nothing to report.</message> </heartbeat>'

describe('parseAutomationHeartbeatMessageContent', () => {
    it('parses injected heartbeat control messages in supported text shapes', () => {
        expect(parseAutomationHeartbeatMessageContent(heartbeat)).toEqual({
            automationId: 'bug',
            decision: 'DONT_NOTIFY',
            message: 'Nothing to report.'
        })
        expect(isAutomationHeartbeatMessageContent({ type: 'text', text: heartbeat })).toBe(true)
        expect(isAutomationHeartbeatMessageContent([{ type: 'text', text: heartbeat }])).toBe(true)
    })

    it('parses heartbeat instructions emitted without decision and message fields', () => {
        const instructionHeartbeat = `<heartbeat>
  <automation_id>bug</automation_id>
  <current_time_iso>2026-08-15T00:54:47.781Z</current_time_iso>
  <instructions>
自动改bug
  </instructions>
</heartbeat>`

        expect(parseAutomationHeartbeatMessageContent(instructionHeartbeat)).toEqual({
            automationId: 'bug',
            message: '自动改bug',
            currentTimeIso: '2026-08-15T00:54:47.781Z'
        })
        expect(isAutomationHeartbeatMessageContent(instructionHeartbeat)).toBe(true)
    })

    it('does not parse ordinary XML-like user text', () => {
        expect(parseAutomationHeartbeatMessageContent('<heartbeat>please check status</heartbeat>')).toBeNull()
        expect(parseAutomationHeartbeatMessageContent('How do I handle <heartbeat> payloads?')).toBeNull()
    })

    it('identifies malformed automation heartbeat control messages', () => {
        const malformed = '<heartbeat> <automation_id>bug</automation_id> truncated'

        expect(isMalformedAutomationHeartbeatMessageContent(malformed)).toBe(true)
        expect(isMalformedAutomationHeartbeatMessageContent({
            type: 'codex',
            data: { type: 'message', message: malformed }
        })).toBe(true)
        expect(isMalformedAutomationHeartbeatMessageContent('<heartbeat>truncated')).toBe(true)
        expect(isMalformedAutomationHeartbeatMessageContent('<heartbeat>please check status</heartbeat>')).toBe(false)
    })
})
