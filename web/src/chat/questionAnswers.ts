import { isObject } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import { isAskUserQuestionToolName, parseAskUserQuestionInput, type AskUserQuestionOption, type AskUserQuestionQuestion } from '@/components/ToolCard/askUserQuestion'
import { isCursorAskQuestionToolName, parseCursorAskQuestionInput } from '@/components/ToolCard/cursorAskQuestion'
import { isRequestUserInputToolName, parseRequestUserInputInput, type RequestUserInputOption, type RequestUserInputQuestion } from '@/components/ToolCard/requestUserInput'

export type QuestionAnswerItem = {
    /** Native desktop question identity; never treated as a pending tool call. */
    questionItemId?: string
    question: string | null
    answers: string[]
    /**
     * Original choices are retained for the compact chat summary's detail
     * sheet. Older stored messages may not have this field, so rendering must
     * gracefully fall back to the selected answers alone.
     */
    options?: QuestionAnswerOption[]
}

export type QuestionAnswerOption = {
    label: string
    description: string | null
    selected: boolean
}

export type QuestionAnswerPresentation = {
    items: QuestionAnswerItem[]
}

export type QuestionAnswerBlock = {
    kind: 'question-answer'
    id: string
    createdAt: number
    invokedAt?: number | null
    answer: QuestionAnswerPresentation
}

type ParsedQuestion = {
    id: string | null
    question: string | null
    options: Array<AskUserQuestionOption | RequestUserInputOption>
}

type AnswerMap = Record<string, string[]>

const QUESTION_REPLY_OPEN = '<send_user_message_question_reply>'
const QUESTION_REPLY_CLOSE = '</send_user_message_question_reply>'

/** Display-only adaptation. Keep malformed, mixed, or conflicting messages intact. */
export function parseUserMessageQuestionReply(text: string): QuestionAnswerPresentation | null {
    const trimmed = text.trim()
    if (!trimmed.startsWith(QUESTION_REPLY_OPEN) || !trimmed.endsWith(QUESTION_REPLY_CLOSE)) return null

    let payload: unknown
    try {
        payload = JSON.parse(trimmed.slice(QUESTION_REPLY_OPEN.length, -QUESTION_REPLY_CLOSE.length))
    } catch {
        return null
    }
    if (!Array.isArray(payload) || payload.length === 0) return null

    const items = new Map<string, QuestionAnswerItem>()
    for (const entry of payload) {
        if (!isObject(entry)
            || typeof entry.questionItemId !== 'string' || !entry.questionItemId.trim()
            || typeof entry.question !== 'string' || !entry.question.trim()
            || typeof entry.answer !== 'string' || !entry.answer.trim()) return null

        const previous = items.get(entry.questionItemId)
        if (previous) {
            // Only identical copies of the same question are safe to collapse.
            if (previous.question !== entry.question || previous.answers[0] !== entry.answer) return null
            continue
        }
        items.set(entry.questionItemId, {
            questionItemId: entry.questionItemId,
            question: entry.question,
            answers: [entry.answer]
        })
    }
    return { items: [...items.values()] }
}

function parseResultAnswers(value: unknown): unknown {
    if (typeof value !== 'string') return value
    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}

function normalizeAnswers(value: unknown): AnswerMap | null {
    const root = isObject(value) && isObject(value.answers) ? value.answers : value
    if (!isObject(root)) return null

    const answers: AnswerMap = {}
    for (const [key, entry] of Object.entries(root)) {
        const values = Array.isArray(entry)
            ? entry
            : isObject(entry) && Array.isArray(entry.answers)
                ? entry.answers
                : null
        if (!values) continue

        const cleaned = values
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        if (cleaned.length > 0) answers[key] = cleaned
    }

    return Object.keys(answers).length > 0 ? answers : null
}

function getAnswerValues(answers: AnswerMap, question: ParsedQuestion, index: number): string[] {
    const keys = [question.id, String(index), question.question]
    for (const key of keys) {
        if (!key) continue
        const values = answers[key]
        if (values && values.length > 0) return values
    }
    return []
}

function resolveAnswerLabel(value: string, options: ParsedQuestion['options']): string {
    const normalized = value.startsWith('user_note: ')
        ? value.slice('user_note: '.length).trim()
        : value
    if (!normalized) return value

    const matchingOption = options.find((option) => (
        option.label === normalized
        || ('id' in option && option.id === normalized)
    ))
    return matchingOption?.label ?? normalized
}

function unique(values: string[]): string[] {
    return values.filter((value, index) => values.indexOf(value) === index)
}

function toParsedQuestions(block: ToolCallBlock): ParsedQuestion[] | null {
    if (isRequestUserInputToolName(block.tool.name)) {
        return parseRequestUserInputInput(block.tool.input).questions.map((question: RequestUserInputQuestion) => ({
            id: question.id,
            question: question.question || null,
            options: question.options
        }))
    }

    if (!isAskUserQuestionToolName(block.tool.name)) return null

    const questions = isCursorAskQuestionToolName(block.tool.name)
        ? parseCursorAskQuestionInput(block.tool.input).questions
        : parseAskUserQuestionInput(block.tool.input).questions
    return questions.map((question: AskUserQuestionQuestion) => ({
        id: question.id ?? null,
        question: question.question || null,
        options: question.options
    }))
}

export function getQuestionAnswerPresentation(block: ToolCallBlock): QuestionAnswerPresentation | null {
    const questions = toParsedQuestions(block)
    if (!questions) return null

    const answers = normalizeAnswers(block.tool.permission?.answers ?? parseResultAnswers(block.tool.result))
    if (!answers) return null

    const items = questions.map((question, index) => {
        const selectedAnswers = unique(getAnswerValues(answers, question, index)
            .map((answer) => resolveAnswerLabel(answer, question.options))
            .filter((answer) => answer.length > 0))
        const selectedLabels = new Set(selectedAnswers)

        return {
            question: question.question,
            answers: selectedAnswers,
            options: question.options.map((option) => ({
                label: option.label,
                description: option.description,
                selected: selectedLabels.has(option.label)
            }))
        }
    }).filter((item) => item.answers.length > 0)

    if (items.length > 0) return { items }

    const fallbackItems = Object.values(answers)
        .map((values) => ({ question: null, answers: unique(values) }))
        .filter((item) => item.answers.length > 0)
    return fallbackItems.length > 0 ? { items: fallbackItems } : null
}

export function toQuestionAnswerBlock(block: ToolCallBlock): QuestionAnswerBlock | null {
    const answer = getQuestionAnswerPresentation(block)
    if (!answer) return null

    const completedAt = block.tool.permission?.completedAt ?? block.tool.completedAt
    const createdAt = typeof completedAt === 'number' && Number.isFinite(completedAt)
        ? completedAt
        : block.createdAt

    return {
        kind: 'question-answer',
        id: block.id,
        createdAt,
        invokedAt: createdAt,
        answer
    }
}

export function formatQuestionAnswerText(answer: QuestionAnswerPresentation): string {
    return answer.items.map((item) => [
        item.question,
        ...item.answers.map((value) => `• ${value}`)
    ].filter((value): value is string => Boolean(value && value.trim())).join('\n')).join('\n\n')
}
