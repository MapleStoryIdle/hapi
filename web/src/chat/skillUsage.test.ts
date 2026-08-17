import { describe, expect, it } from 'vitest'
import type { AgentTextBlock, ChatBlock, ToolCallBlock } from '@/chat/types'
import { detectExplicitSkillName, normalizeExplicitSkillUsage } from '@/chat/skillUsage'

function agentText(id: string, text: string): AgentTextBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

function shellRead(id: string, command: string): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 2,
        invokedAt: 2,
        tool: {
            id,
            name: 'CodexBash',
            state: 'completed',
            input: { command },
            createdAt: 2,
            startedAt: 2,
            completedAt: 2_750,
            durationMs: 750,
            description: 'Read skill instructions',
            result: '# imagegen instructions',
            permission: undefined,
        },
        children: [],
    }
}

describe('detectExplicitSkillName', () => {
    it('recognizes explicit Chinese and English skill announcements', () => {
        expect(detectExplicitSkillName('使用 `imagegen`：生成预览图。')).toBe('imagegen')
        expect(detectExplicitSkillName('Using frontend-design for this screen.')).toBe('frontend-design')
    })

    it('does not treat generic tool language as a skill name', () => {
        expect(detectExplicitSkillName('Use tool to inspect the logs.')).toBeNull()
    })
})

describe('normalizeExplicitSkillUsage', () => {
    it('converts an announced skill plus its matching SKILL.md read into a standalone Skill block', () => {
        const intro = agentText('intro', '使用 `imagegen`：你要生成一张聊天会话主题的位图图片。')
        const read = shellRead('read-skill', "/bin/zsh -lc 'cat /Users/dev/.codex/skills/.system/imagegen/SKILL.md'")
        const result = agentText('result', '已生成。')

        const normalized = normalizeExplicitSkillUsage([intro, read, result])

        expect(normalized).toHaveLength(2)
        expect(normalized[0]).toMatchObject({
            kind: 'tool-call',
            id: 'skill:read-skill',
            tool: {
                id: 'skill:read-skill',
                name: 'Skill',
                input: { skill: 'imagegen' },
                state: 'completed',
                durationMs: 750,
                description: '使用 `imagegen`：你要生成一张聊天会话主题的位图图片。',
                result: null,
            }
        })
        expect(normalized[1]).toBe(result)
    })

    it('keeps an ordinary SKILL.md read when it lacks a matching explicit announcement', () => {
        const intro = agentText('intro', '使用 `imagegen`：生成预览图。')
        const read = shellRead('read-other-skill', "/bin/zsh -lc 'cat /Users/dev/.codex/skills/.system/frontend-design/SKILL.md'")
        const blocks: ChatBlock[] = [intro, read]

        expect(normalizeExplicitSkillUsage(blocks)).toEqual(blocks)
    })
})
