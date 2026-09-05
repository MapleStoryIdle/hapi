import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { isConfirmedNativeSendRejection } from './native-send-outcome'

describe('native send certainty', () => {
    it.each(['launch_failed', 'queue_full', 'workspace_unavailable', 'external_writer_active', 'session_busy'])(
        'accepts an explicit rejection: %s', (code) => {
            expect(isConfirmedNativeSendRejection(new ApiError('rejected', 502, code))).toBe(true)
        }
    )
    it.each([
        new ApiError('timeout', 408, 'request_timeout'),
        new ApiError('gateway', 502),
        new ApiError('unknown', 409, 'session_status_unknown'),
        new TypeError('Failed to fetch'),
        new DOMException('cancelled', 'AbortError')
    ])('does not turn missing evidence into a failure: %s', (error) => {
        expect(isConfirmedNativeSendRejection(error)).toBe(false)
    })
    it('does not label an existing prompt failed when its recovery is busy', () => {
        expect(isConfirmedNativeSendRejection(new ApiError('already queued', 409, 'session_busy'), { recovery: true })).toBe(false)
    })
})
