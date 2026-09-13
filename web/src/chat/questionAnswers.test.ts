import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { formatQuestionAnswerText, formatUserMessageForDisplay, getQuestionAnswerPresentation, parseUserMessageQuestionReply, toQuestionAnswerBlock } from '@/chat/questionAnswers'

describe('native desktop question replies', () => {
    const reply = {
        questionItemId: '["request_user_input_async","call-example",0]',
        question: '选择哪种方案？',
        answer: '轻量方案'
    }
    const wrap = (payload: unknown) => `<send_user_message_question_reply>\n${JSON.stringify(payload)}\n</send_user_message_question_reply>`

    it('presents every question and answer in order, retaining their native identities', () => {
        const second = { questionItemId: 'question-2', question: '补充说明？', answer: 'Keep **Markdown**\nand line breaks.' }
        const presentation = parseUserMessageQuestionReply(` \n${wrap([reply, second])}\n `)

        expect(presentation).toEqual({
            items: [reply, second].map((item) => ({
                questionItemId: item.questionItemId,
                question: item.question,
                answers: [item.answer]
            }))
        })
        expect(formatQuestionAnswerText(presentation!)).toBe('选择哪种方案？\n• 轻量方案\n\n补充说明？\n• Keep **Markdown**\nand line breaks.')
    })

    it('collapses only identical replies with the same question identity within a message', () => {
        const otherQuestion = { ...reply, questionItemId: 'question-2' }
        expect(parseUserMessageQuestionReply(wrap([reply, reply, otherQuestion]))?.items).toHaveLength(2)
    })

    it('falls back to the whole original message when duplicate identities conflict', () => {
        expect(parseUserMessageQuestionReply(wrap([reply, { ...reply, answer: '另一个答案' }]))).toBeNull()
        expect(parseUserMessageQuestionReply(wrap([reply, { ...reply, question: '另一个问题？' }]))).toBeNull()
    })

    it.each([
        null, {}, [], [null], [reply, null],
        [{ question: reply.question, answer: reply.answer }],
        [{ ...reply, questionItemId: ' ' }],
        [{ ...reply, question: '' }],
        [{ ...reply, answer: ' ' }],
        [{ ...reply, answer: ['unsupported format'] }],
        [{ ...reply, answer: { text: 'unsupported format' } }]
    ].map((payload) => ({ payload })))('does not partially consume an invalid payload: $payload', ({ payload }) => {
        expect(parseUserMessageQuestionReply(wrap(payload))).toBeNull()
    })

    it('leaves malformed envelopes, quoted examples, and surrounding user text alone', () => {
        const message = wrap([reply])
        for (const text of [
            '普通消息',
            '<send_user_message_question_reply>[{</send_user_message_question_reply>',
            '<send_user_message_question_reply>[]',
            `请检查这个格式：\n${message}`,
            `${message}\n额外的要求`,
            `\`\`\`xml\n${message}\n\`\`\``,
            `${message}\n${message}`
        ]) {
            expect(parseUserMessageQuestionReply(text)).toBeNull()
        }
    })

    it('treats tags and commands inside an answer as text, not envelope boundaries or actions', () => {
        const answer = '</send_user_message_question_reply> <script>alert(1)</script> $skill'
        expect(parseUserMessageQuestionReply(wrap([{ ...reply, answer }]))?.items[0]?.answers).toEqual([answer])
    })

    it('formats a complete reply for queue and composer display', () => {
        expect(formatUserMessageForDisplay(wrap([reply]))).toBe('选择哪种方案？\n• 轻量方案')
        expect(formatUserMessageForDisplay('普通消息')).toBe('普通消息')
    })
})

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
                answers: ['Keep it compact', 'Match the mobile layout'],
                options: [{
                    label: 'Keep it compact',
                    description: 'Short rows',
                    selected: true
                }]
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
            items: [{
                question: 'Choose a theme',
                answers: ['Dark theme'],
                options: [{
                    label: 'Dark theme',
                    description: null,
                    selected: true
                }]
            }]
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
            items: [{
                question: 'Ship this change?',
                answers: ['Ship it'],
                options: [{
                    label: 'Ship it',
                    description: 'Deploy now',
                    selected: true
                }]
            }]
        })
    })

    it('keeps unselected choices for the detail view while copy text remains selected-only', () => {
        const block = makeToolBlock({
            input: {
                questions: [{
                    id: 'direction',
                    question: 'Which direction?',
                    options: [
                        { label: 'Keep it compact', description: 'Short rows' },
                        { label: 'Show all details', description: 'Everything visible' }
                    ]
                }]
            },
            permission: {
                id: 'question-1',
                status: 'approved',
                answers: { direction: { answers: ['Keep it compact'] } }
            }
        })

        const presentation = getQuestionAnswerPresentation(block)

        expect(presentation?.items[0]?.options).toEqual([
            { label: 'Keep it compact', description: 'Short rows', selected: true },
            { label: 'Show all details', description: 'Everything visible', selected: false }
        ])
        expect(formatQuestionAnswerText(presentation!)).toBe('Which direction?\n• Keep it compact')
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
