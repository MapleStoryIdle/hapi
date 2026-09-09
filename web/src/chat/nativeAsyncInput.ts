import type { NormalizedMessage } from './types'
import { parseUserMessageQuestionReply } from './questionAnswers'
import { isObject } from '@hapi/protocol'

export type NativeAsyncInput = {
    callId: string
    questions: Array<{ id: string; question: string; options: string[] }>
    answers?: Record<string, string[]>
    resolved?: boolean
}

/** Keep each request in its original message position, including its answers. */
export function getNativeAsyncInputs(messages: readonly NormalizedMessage[]): NativeAsyncInput[] {
    const requests = new Map<string, NativeAsyncInput>()
    const answers: Record<string, string[]> = {}
    const canceled = new Set<string>()
    for (const message of messages) {
        if (message.role === 'user') {
            for (const item of parseUserMessageQuestionReply(message.content.text)?.items ?? []) {
                if (item.questionItemId) answers[item.questionItemId] = item.answers
            }
        }
        if (message.role !== 'agent') continue
        for (const part of message.content) {
            if (part.type === 'tool-result') {
                let result: unknown = part.content
                if (typeof result === 'string') {
                    try { result = JSON.parse(result) } catch { /* Plain output. */ }
                }
                if (part.is_error || (isObject(result) && (result.canceled === true || result.cancelled === true))) canceled.add(part.tool_use_id)
            }
            if (part.type !== 'tool-call' || part.name.split('.').pop() !== 'request_user_input_async') continue
            if (!isObject(part.input) || !Array.isArray(part.input.questions)) continue
            const questions: NativeAsyncInput['questions'] = []
            part.input.questions.slice(0, 3).forEach((raw, index) => {
                if (!isObject(raw) || typeof raw.title !== 'string' || !raw.title.trim()) return
                questions.push({
                    id: JSON.stringify(['request_user_input_async', part.id, index]),
                    question: raw.title,
                    options: Array.isArray(raw.options) ? raw.options.filter((option): option is string => typeof option === 'string') : []
                })
            })
            if (questions.length) requests.set(part.id, { callId: part.id, questions })
        }
    }
    return [...requests.values()].map((input) => ({
        ...input,
        answers: Object.fromEntries(input.questions.filter((q) => answers[q.id]?.length).map((q) => [q.id, answers[q.id]])),
        resolved: canceled.has(input.callId) || input.questions.every((q) => answers[q.id]?.length)
    }))
}

/** Async receipt/completion is not a person's answer. Keep the latest form
 * recoverable from transcript history, including after a page remount. */
export function getPendingNativeAsyncInput(messages: readonly NormalizedMessage[]): NativeAsyncInput | null {
    const latest = getNativeAsyncInputs(messages).at(-1)
    if (!latest || latest.resolved) return null
    const questions = latest.questions.filter((question) => !latest.answers?.[question.id]?.length)
    return questions.length ? { callId: latest.callId, questions } : null
}
