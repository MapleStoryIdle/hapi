import { describe, expect, it } from 'vitest'
import type { AgentEvent, ChatBlock } from '@/chat/types'
import { buildConversationOutline, truncateOutlineLabel } from '@/chat/outline'

function userBlock(
    id: string,
    text: string,
    createdAt: number,
    overrides: Partial<Extract<ChatBlock, { kind: 'user-text' }>> = {}
): ChatBlock {
    return {
        kind: 'user-text',
        id,
        localId: null,
        createdAt,
        text,
        ...overrides
    }
}

function eventBlock(id: string, event: AgentEvent, createdAt: number): ChatBlock {
    return {
        kind: 'agent-event',
        id,
        createdAt,
        event,
    }
}

describe('conversation outline', () => {
    it('uses readable questions and answers while keeping the native message anchor', () => {
        const text = `<send_user_message_question_reply>${JSON.stringify([{
            questionItemId: 'question-1', question: '选择哪种方案？', answer: '轻量方案'
        }])}</send_user_message_question_reply>`
        expect(buildConversationOutline([userBlock('reply', text, 1_000)])).toEqual([{
            id: 'outline:user-text:reply',
            targetMessageId: 'user-text:reply',
            kind: 'user',
            label: '选择哪种方案？ • 轻量方案',
            createdAt: 1_000
        }])
    })

    it('creates outline items from user messages', () => {
        expect(buildConversationOutline([
            userBlock('m1', 'Implement the outline panel', 1000),
        ])).toEqual([
            {
                id: 'outline:user-text:m1',
                targetMessageId: 'user-text:m1',
                kind: 'user',
                label: 'Implement the outline panel',
                createdAt: 1000
            }
        ])
    })

    it('ignores title and summary events', () => {
        const items = buildConversationOutline([
            eventBlock('e1', { type: 'title-changed', title: 'Add conversation outline' }, 1000),
            eventBlock('e2', { type: 'message', message: 'Context compacted into a summary.' }, 2000),
            eventBlock('e3', { type: 'ready' }, 3000),
        ])

        expect(items).toEqual([])
    })

    it('handles empty and long labels', () => {
        expect(buildConversationOutline([
            userBlock('empty', ' \n\t ', 1000),
        ])[0]?.label).toBe('Empty message')

        expect(truncateOutlineLabel('a '.repeat(80), 20)).toBe('a a a a a a a a a...')
    })

    it('filters queued user messages that are not yet locatable in the thread', () => {
        const items = buildConversationOutline([
            userBlock('queued', 'Queued prompt', 1000, { status: 'queued', invokedAt: null }),
            userBlock('sent', 'Visible prompt', 2000, { status: 'sent', invokedAt: 2500 }),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:sent'
        ])
    })

    it('keeps block order stable', () => {
        const items = buildConversationOutline([
            userBlock('first', 'First', 1000),
            eventBlock('summary', { type: 'message', message: 'Summary' }, 900),
            userBlock('second', 'Second', 1100),
        ])

        expect(items.map((item) => item.id)).toEqual([
            'outline:user-text:first',
            'outline:user-text:second'
        ])
    })
})
