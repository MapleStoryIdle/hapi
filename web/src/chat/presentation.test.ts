import { describe, expect, it } from 'vitest'
import { getEventPresentation, formatMessageTimestamp, formatResetTime, isUsageLimitEvent } from './presentation'

describe('getEventPresentation — agent errors', () => {
    it('formats error events with warning icon and message text', () => {
        const result = getEventPresentation({
            type: 'error',
            message: 'Cursor Agent failed: authentication required'
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toBe('Cursor Agent failed: authentication required')
    })
})

describe('getEventPresentation — task-status', () => {
    it('formats retrying task status with attempt counts', () => {
        const result = getEventPresentation({
            type: 'task-status',
            status: 'retrying',
            source: 'codex',
            code: 'system_error',
            message: 'Codex thread entered systemError',
            retryAttempt: 1,
            maxRetries: 3,
            recoverable: true
        })

        expect(result.icon).toBe('↻')
        expect(result.text).toBe('Codex task failed; retrying 1/3')
    })

    it('formats usage-limit final failures', () => {
        const result = getEventPresentation({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false,
            resetAtText: '9:43 AM',
            actionUrl: 'https://chatgpt.com/codex/settings/usage'
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toBe('Codex usage limit reached · try again at 9:43 AM')
    })

    it('formats classified and older unclassified network failures without the generic task-failed label', () => {
        const result = getEventPresentation({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'network_error',
            message: 'Network error: request timed out',
            recoverable: false
        })

        expect(result).toEqual({ icon: '⚠️', text: 'Network connection issue' })
        expect(getEventPresentation({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'unknown',
            message: 'stream disconnected before completion: error sending request',
            recoverable: false
        })).toEqual({ icon: '⚠️', text: 'Network connection issue' })
    })
})

describe('getEventPresentation — limit-warning', () => {
    it('formats five_hour warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⚠️')
        expect(result.text).toMatch(/Usage limit 90% \(5-hour\)/)
        expect(result.text).toMatch(/resets/)
    })

    it('formats seven_day warning', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.85,
            endsAt: 1774850400,
            limitType: 'seven_day',
        })

        expect(result.text).toMatch(/Usage limit 85% \(7-day\)/)
    })

    it('omits type label when limitType is empty', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 1,
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.text).toMatch(/^Usage limit 100% · resets/)
        expect(result.text).not.toMatch(/\(/)
    })

    it('formats unknown limitType with underscore replacement', () => {
        const result = getEventPresentation({
            type: 'limit-warning',
            utilization: 0.5,
            endsAt: 1774278000,
            limitType: 'thirty_day',
        })

        expect(result.text).toMatch(/\(thirty day\)/)
    })
})

describe('getEventPresentation — limit-reached', () => {
    it('shows limitType when present', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached \(5-hour\) until/)
    })

    it('omits limitType when empty', () => {
        const result = getEventPresentation({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: '',
        })

        expect(result.icon).toBe('⏳')
        expect(result.text).toMatch(/^Usage limit reached until/)
        expect(result.text).not.toMatch(/\(/)
    })
})

describe('Codex usage updates', () => {
    it('uses a concise label while retaining the full event payload for the divider detail', () => {
        expect(getEventPresentation({
            type: 'codex-usage-updated',
            message: 'Codex usage updated · GPT-5.3-Codex-Spark: primary 0% / 300 min'
        })).toEqual({
            icon: '◷',
            text: 'Codex usage updated'
        })
    })
})

describe('isUsageLimitEvent', () => {
    it('includes every quota event rendered as a compact divider', () => {
        expect(isUsageLimitEvent({
            type: 'codex-usage-updated',
            message: 'Codex usage updated · primary 0%'
        })).toBe(true)
        expect(isUsageLimitEvent({
            type: 'limit-warning',
            utilization: 0.9,
            endsAt: 1774278000,
            limitType: 'five_hour'
        })).toBe(true)
        expect(isUsageLimitEvent({
            type: 'limit-reached',
            endsAt: 1774278000,
            limitType: 'five_hour'
        })).toBe(true)
        expect(isUsageLimitEvent({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'usage_limit',
            message: "You've hit your usage limit.",
            recoverable: false
        })).toBe(true)
    })

    it('leaves non-quota task failures as cards', () => {
        expect(isUsageLimitEvent({
            type: 'task-status',
            status: 'failed',
            source: 'codex',
            code: 'model_capacity',
            message: 'Selected model is at capacity.',
            recoverable: false
        })).toBe(false)
    })
})

describe('getEventPresentation — token-count', () => {
    it('formats Codex token-count as compact context usage', () => {
        const result = getEventPresentation({
            type: 'token-count',
            info: {
                total: {
                    totalTokens: 23745,
                    inputTokens: 23631,
                    cachedInputTokens: 18176,
                    outputTokens: 114,
                    reasoningOutputTokens: 0
                },
                modelContextWindow: 258400
            }
        })

        expect(result.icon).toBe('◷')
        expect(result.text).toBe('Context 23.6k / 258.4k (9%) · out 114 · cached 18.2k')
    })
})

describe('getEventPresentation — thread goals', () => {
    it('formats goal status updates', () => {
        const result = getEventPresentation({
            type: 'thread-goal-updated',
            goal: {
                threadId: 'thread-1',
                objective: 'ship goal support',
                status: 'budgetLimited',
                tokenBudget: 5000,
                tokensUsed: 4100,
                timeUsedSeconds: 0,
                createdAt: 1,
                updatedAt: 2
            }
        })

        expect(result.text).toBe('Goal limited by budget · 4k / 5k')
    })

    it('formats goal clear events', () => {
        const result = getEventPresentation({ type: 'thread-goal-cleared', threadId: 'thread-1' })

        expect(result.text).toBe('Goal cleared')
    })
})

describe('formatResetTime', () => {
    it('formats a unix timestamp to a non-empty string', () => {
        const result = formatResetTime(1774278000)
        expect(result).toBeTruthy()
        expect(typeof result).toBe('string')
    })

    it('handles millisecond timestamps', () => {
        const result = formatResetTime(1774278000000)
        expect(result).toBeTruthy()
    })

    it('returns raw value for invalid timestamps', () => {
        const result = formatResetTime(NaN)
        expect(result).toBeTruthy()
    })
})

describe('formatMessageTimestamp', () => {
    it('formats today without requiring a date prefix', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const result = formatMessageTimestamp(new Date(2026, 4, 22, 9, 5), now)
        expect(result).toBeTruthy()
        expect(result).not.toContain('2026')
    })

    it('includes a year for messages outside the current year', () => {
        const now = new Date(2026, 4, 22, 14, 30)
        const result = formatMessageTimestamp(new Date(2025, 11, 31, 23, 59), now)
        expect(result).toContain('2025')
    })
})


describe('getEventPresentation — Codex session events', () => {
    it('formats supported session events without raw payload output', () => {
        expect(getEventPresentation({ type: 'codex-session-event', eventType: 'mcp_startup_update', current: 1, total: 2 }).text).toBe('MCP servers starting 1/2')
        expect(getEventPresentation({ type: 'codex-session-event', eventType: 'mcp_startup_complete' }).text).toBe('MCP servers ready')
        expect(getEventPresentation({ type: 'codex-session-event', eventType: 'skills_update_available' }).text).toBe('Skills updated')
        expect(getEventPresentation({ type: 'codex-session-event', eventType: 'stream_error' }).text).toBe('Codex stream issue; recovery may continue')
        expect(getEventPresentation({ type: 'codex-session-event', eventType: 'warning' }).text).toBe('Codex warning')
        expect(getEventPresentation({ type: 'unknown-event', secret: 'do-not-leak' }).text).toBe('Session event')
    })
})
