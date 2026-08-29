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
        deliveryPhase: 'launching' as const,
        phaseStartedAt: Date.now(),
        queueId: null,
        observedTranscriptMessageIds: ['old-message'],
        observedThroughPosition: 4
    }
}

describe('native Codex direct-message receipts', () => {
    beforeEach(() => {
        sessionStorage.clear()
        localStorage.clear()
    })

    it('keeps an optimistic receipt when the native session page remounts', () => {
        const echo = makeEcho('local-1')
        updateNativeCodexDirectMessageEchoes(scope, () => [echo])

        expect(readNativeCodexDirectMessageEchoes(scope)).toEqual([echo])
        expect(localStorage.length).toBe(1)
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

    it('preserves an expanded delivery text for native transcript reconciliation', () => {
        const echo = {
            ...makeEcho('local-expanded'),
            text: '/review src/index.ts',
            deliveryText: 'Review the requested code.\n\nUser arguments: src/index.ts'
        }
        updateNativeCodexDirectMessageEchoes(scope, () => [echo])

        expect(readNativeCodexDirectMessageEchoes(scope)).toEqual([echo])
    })
})
