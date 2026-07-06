import { describe, expect, it } from 'bun:test'
import { MAX_UPLOAD_BYTES } from '@hapi/protocol'
import { MAX_GENERATED_IMAGE_BYTES, SOCKET_MAX_HTTP_BUFFER_SIZE } from './socketLimits'

describe('socket limits', () => {
    it('buffer size can carry the largest accepted binary image frame', () => {
        // Generated images and uploaded previews use Socket.IO binary frames. The buffer must
        // exceed both raw caps and stay well above the 1 MB engine default that regressed.
        expect(SOCKET_MAX_HTTP_BUFFER_SIZE).toBeGreaterThan(MAX_GENERATED_IMAGE_BYTES)
        expect(SOCKET_MAX_HTTP_BUFFER_SIZE).toBeGreaterThan(MAX_UPLOAD_BYTES)
        expect(SOCKET_MAX_HTTP_BUFFER_SIZE).toBeGreaterThan(1e6)
    })
})
