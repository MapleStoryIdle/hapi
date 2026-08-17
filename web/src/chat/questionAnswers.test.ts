import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { formatQuestionAnswerText, getQuestionAnswerPresentation, toQuestionAnswerBlock } from '@/chat/questionAnswers'

function makeToolBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'question-1',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'question-1',
            name: 'request_user_input',
            state: 'completed',
            input: {
                questions: [{
                    id: 'direction',
                    question: 'Which direction?',
                    options: [{ label: 'Keep it compact', description: 'Short rows' }]
                }]
            },
            createdAt: 1_000,
            startedAt: 1_000,
            completedAt: 1_400,
            description: null,
            ...overrides
        },
        children: []
    }
}

describe('question answer presentation', () => {
    it('renders request_user_input selections as a user choice', () => {
        const block = makeToolBlock({
            permission: {
                id: 'question-1',
                status: 'approved',
                completedAt: 1_600,
                answers: {
                    direction: { answers: ['Keep it compact', 'user_note: Match the mobile layout'] }
                }
            }
        })

        expect(getQuestionAnswerPresentation(block)).toEqual({
            items: [{
                question: 'Which direction?',
                answers: ['Keep it compact', 'Match the mobile layout']
            }]
        })
        expect(toQuestionAnswerBlock(block)).toMatchObject({
            kind: 'question-answer',
            id: 'question-1',
            createdAt: 1_600
        })
    })

    it('resolves Cursor option ids to their visible labels', () => {
        const block = makeToolBlock({
            name: 'CursorAskQuestion',
            input: {
                questions: [{
                    id: 'theme',
                    prompt: 'Choose a theme',
                    options: [{ id: 'dark', label: 'Dark theme' }]
                }]
            },
            permission: {
                id: 'question-1',
                status: 'approved',
                answers: { theme: ['dark'] }
            }
        })

        expect(getQuestionAnswerPresentation(block)).toEqual({
            items: [{ question: 'Choose a theme', answers: ['Dark theme'] }]
        })
    })

    it('keeps a normal AskUserQuestion answer as a user selection', () => {
        const block = makeToolBlock({
            name: 'AskUserQuestion',
            input: {
                questions: [{
                    question: 'Ship this change?',
                    options: [{ label: 'Ship it', description: 'Deploy now' }]
                }]
            },
            permission: {
                id: 'question-1',
                status: 'approved',
                answers: { 0: ['Ship it'] }
            }
        })

        expect(getQuestionAnswerPresentation(block)).toEqual({
            items: [{ question: 'Ship this change?', answers: ['Ship it'] }]
        })
    })

    it('does not convert a pending question without a user answer', () => {
        const block = makeToolBlock({
            state: 'pending',
            permission: { id: 'question-1', status: 'pending' }
        })

        expect(getQuestionAnswerPresentation(block)).toBeNull()
        expect(toQuestionAnswerBlock(block)).toBeNull()
    })

    it('formats selected answers for copy without exposing unselected options', () => {
        expect(formatQuestionAnswerText({
            items: [{ question: 'Which direction?', answers: ['Keep it compact'] }]
        })).toBe('Which direction?\n• Keep it compact')
    })
})
