import { describe, expect, it } from 'bun:test'
import { isCodexAuthenticationError, isHttpForbiddenError } from './utils'

describe('isHttpForbiddenError', () => {
    it.each([
        'unexpected status 403 Forbidden: <html>private response</html>',
        'HTTP 403',
        'HTTP/1.1 403 Forbidden',
        'Request failed with status code 403',
        'stream disconnected before completion: HTTP 403 Forbidden'
    ])('recognizes %s', (message) => {
        expect(isHttpForbiddenError(message)).toBe(true)
    })

    it.each([
        null, undefined, {}, '', 'Task failed', 'HTTP 401 Unauthorized',
        'HTTP 429 Too Many Requests', 'HTTP 4030', 'Task 403 failed',
        'HTTP 500: <html>HTTP 403 Forbidden</html>'
    ])('does not misclassify %j', (message) => {
        expect(isHttpForbiddenError(message)).toBe(false)
    })
})

describe('isCodexAuthenticationError', () => {
    it.each([
        'HTTP 401 Unauthorized',
        'Authentication required',
        'Not logged in. Run codex login.',
        'Your access token has expired',
        'User logged out'
    ])('recognizes %s', (message) => {
        expect(isCodexAuthenticationError(message)).toBe(true)
    })

    it.each([null, '', 'HTTP 403 Forbidden', 'Network request failed', 'Task failed'])('does not misclassify %j', (message) => {
        expect(isCodexAuthenticationError(message)).toBe(false)
    })
})
