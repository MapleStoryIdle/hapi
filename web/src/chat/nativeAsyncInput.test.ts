import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from './types'
import { getNativeAsyncInputs, getPendingNativeAsyncInput } from './nativeAsyncInput'
import { normalizeDecryptedMessage } from './normalize'

const base = { id: 'm1', localId: null, createdAt: 1, isSidechain: false }
const request: NormalizedMessage = { ...base, role: 'agent', content: [{
    type: 'tool-call', id: 'call-1', name: 'request_user_input_async',
    input: { questions: [{ title: 'Which route?', options: ['Team', 'Solo'] }] },
    description: null, uuid: 'call-1', parentUUID: null
}] }
const receipt: NormalizedMessage = { ...base, id: 'm2', role: 'agent', content: [{
    type: 'tool-result', tool_use_id: 'call-1', content: '{"accepted":true}',
    is_error: false, uuid: 'receipt', parentUUID: null
}] }

describe('native async input', () => {
    it('keeps one historical card per call with its own desktop answer', () => {
        const reply: NormalizedMessage = { ...base, id: 'reply', role: 'user', content: { text: '<send_user_message_question_reply>[{"questionItemId":"[\\"request_user_input_async\\",\\"call-1\\",0]","question":"Which route?","answer":"Solo"}]</send_user_message_question_reply>' } } as NormalizedMessage
        const cards = getNativeAsyncInputs([request, request, receipt, reply])
        expect(cards).toHaveLength(1)
        expect(cards[0]).toMatchObject({ resolved: true, answers: { '["request_user_input_async","call-1",0]': ['Solo'] } })
        expect(getNativeAsyncInputs([request, receipt])[0].resolved).toBe(false)
    })
    it('recovers the actual imported Codex function-call format, preserving its call id', () => {
        // Actual output shape from appendCodexTranscriptImportLines; keep the
        // Node-only transcript reader out of the browser TypeScript graph.
        const imported = [
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'request_user_input_async', callId: 'call-real', input: { questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] }, id: 'call-record' } }, meta: { sentFrom: 'cli' } },
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: 'call-real', output: '{"accepted":true}', id: 'result-record' } }, meta: { sentFrom: 'cli' } }
        ]
        const normalized = imported.map((content, index) => normalizeDecryptedMessage({ id: String(index), seq: index, localId: null, createdAt: index, content }))
            .filter((message): message is NormalizedMessage => message !== null)
        expect(getPendingNativeAsyncInput(normalized)).toMatchObject({ callId: 'call-real', questions: [{ id: '["request_user_input_async","call-real",0]' }] })
    })
    it('retains the question after the async ACK, assistant final and page reconstruction', () => {
        const history: NormalizedMessage[] = [request, receipt, { ...base, id: 'final', role: 'agent', content: [{ type: 'text', text: 'Please choose.', uuid: 'final', parentUUID: null }] }]
        const pending = getPendingNativeAsyncInput(history)
        expect(pending?.questions).toEqual([{ id: '["request_user_input_async","call-1",0]', question: 'Which route?', options: ['Team', 'Solo'] }])
        expect(getPendingNativeAsyncInput(structuredClone(history))).toEqual(pending)
    })
    it('resolves only an explicit answer for this question identity', () => {
        const reply = (id: string): NormalizedMessage => ({ ...base, id: 'reply', role: 'user', content: { type: 'text', text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId: id, question: 'Which route?', answer: 'Solo' }])}</send_user_message_question_reply>` } })
        expect(getPendingNativeAsyncInput([request, receipt, reply('unrelated')])).not.toBeNull()
        expect(getPendingNativeAsyncInput([request, receipt, reply('["request_user_input_async","call-1",0]')])).toBeNull()
    })
    it('does not resurrect explicitly canceled questions', () => {
        const canceled: NormalizedMessage = { ...base, role: 'agent', content: [{ type: 'tool-result', tool_use_id: 'call-1', content: { canceled: true }, is_error: false, uuid: 'cancel', parentUUID: null }] }
        expect(getPendingNativeAsyncInput([request, canceled])).toBeNull()
    })
})
