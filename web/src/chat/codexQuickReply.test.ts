import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import {
    getPendingCodexQuickReplyPrompt,
    isCodexConfirmationPrompt,
} from '@/chat/codexQuickReply'

function agentMessage(id: string, text: string, isSidechain = false): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: 1,
        role: 'agent',
        isSidechain,
        content: [{ type: 'text', text, uuid: id, parentUUID: null }]
    }
}

function userMessage(id: string, text: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: 2,
        role: 'user',
        isSidechain: false,
        content: { type: 'text', text }
    }
}

describe('Codex quick reply detection', () => {
    it('recognizes Chinese confirmation and continuation requests', () => {
        expect(isCodexConfirmationPrompt('这个方案是否同意我继续执行？')).toBe(true)
        expect(isCodexConfirmationPrompt('请确认后我再部署。')).toBe(true)
        expect(isCodexConfirmationPrompt('要我继续吗？')).toBe(true)
    })

    it('recognizes English confirmation and continuation requests', () => {
        expect(isCodexConfirmationPrompt('Shall I proceed with the deployment?')).toBe(true)
        expect(isCodexConfirmationPrompt('Please confirm.')).toBe(true)
    })

    it('does not mistake status text or code for a confirmation request', () => {
        expect(isCodexConfirmationPrompt('部署已经完成。')).toBe(false)
        expect(isCodexConfirmationPrompt('```ts\nawait confirm();\n```\n实现已完成。')).toBe(false)
    })

    it('keeps only the latest unanswered normal agent question', () => {
        const prompt = getPendingCodexQuickReplyPrompt([
            userMessage('u1', '开始部署'),
            agentMessage('a1', '是否同意我继续执行？')
        ])

        expect(prompt).toEqual({ messageId: 'a1' })
    })

    it('clears the shortcut after a user reply and ignores sidechain prompts', () => {
        expect(getPendingCodexQuickReplyPrompt([
            agentMessage('a1', '是否同意我继续执行？'),
            userMessage('u1', '不用了')
        ])).toBeNull()

        expect(getPendingCodexQuickReplyPrompt([
            agentMessage('a1', '是否同意我继续执行？'),
            agentMessage('a2', '已为你整理好下一步。')
        ])).toBeNull()

        expect(getPendingCodexQuickReplyPrompt([
            agentMessage('a1', '是否同意我继续执行？', true)
        ])).toBeNull()
    })
})
