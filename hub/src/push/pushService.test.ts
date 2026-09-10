import { describe, expect, it } from 'bun:test'
import { shouldSendBarkFallback } from './pushService'

describe('shouldSendBarkFallback', () => {
    it('uses Bark when no PWA subscription exists', () => {
        expect(shouldSendBarkFallback(0, 'BARK_DEVICE_KEY')).toBe(true)
    })

    it('does not duplicate a notification to Bark when PWA is subscribed', () => {
        expect(shouldSendBarkFallback(1, 'BARK_DEVICE_KEY')).toBe(false)
        expect(shouldSendBarkFallback(2, 'BARK_DEVICE_KEY')).toBe(false)
    })

    it('does not use Bark when it is disabled or unconfigured', () => {
        expect(shouldSendBarkFallback(0, null)).toBe(false)
    })
})
