import { describe, expect, it } from 'bun:test'
import { resolveReplayLastEventId } from './events'

describe('events replay cursor', () => {
    it('keeps a cursor from the current Hub stream epoch', () => {
        expect(resolveReplayLastEventId({
            lastEventId: 100,
            lastStreamEpoch: 'hub-a',
            currentStreamEpoch: 'hub-a'
        })).toBe(100)
    })

    it('replays the current history when a cursor belongs to an old Hub', () => {
        expect(resolveReplayLastEventId({
            lastEventId: 100,
            lastStreamEpoch: 'hub-a',
            currentStreamEpoch: 'hub-b'
        })).toBe(0)
    })

    it('does not replay history on a fresh connection without a cursor', () => {
        expect(resolveReplayLastEventId({
            lastEventId: null,
            lastStreamEpoch: null,
            currentStreamEpoch: 'hub-b'
        })).toBeNull()
    })
})
