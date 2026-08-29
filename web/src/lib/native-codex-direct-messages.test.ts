import { beforeEach, describe, expect, it } from 'vitest'
import {
    readNativeCodexDirectMessageEchoes,
    updateNativeCodexDirectMessageEchoes,
    type NativeCodexDirectMessageScope
} from './native-codex-direct-messages'

const scope: NativeCodexDirectMessageScope = {
    machineId: 'machine-1',
    sessionId: 'thread-1'
}

function makeEcho(id: string) {
    return {
        id,
        text: `Message ${id}`,
        createdAt: Date.now(),
        status: 'sending' as const,
        queueId: null,
        observedTranscriptMessageIds: ['old-message'],
        observedThroughPosition: 4
    }
}

describe('native Codex direct-message receipts', () => {
    beforeEach(() => {
        sessionStorage.clear()
    })

    it('keeps an optimistic receipt when the native session page remounts', () => {
        const echo = makeEcho('local-1')
        updateNativeCodexDirectMessageEchoes(scope, () => [echo])

        expect(readNativeCodexDirectMessageEchoes(scope)).toEqual([echo])
    })

    it('keeps receipts isolated by runner and native thread', () => {
        updateNativeCodexDirectMessageEchoes(scope, () => [makeEcho('local-1')])
        const otherScope = { ...scope, machineId: 'machine-2' }

        expect(readNativeCodexDirectMessageEchoes(otherScope)).toEqual([])
        expect(readNativeCodexDirectMessageEchoes(scope)).toHaveLength(1)
    })

    it('removes a receipt after transcript reconciliation', () => {
        updateNativeCodexDirectMessageEchoes(scope, () => [makeEcho('local-1')])
        updateNativeCodexDirectMessageEchoes(scope, () => [])

        expect(readNativeCodexDirectMessageEchoes(scope)).toEqual([])
    })
})
