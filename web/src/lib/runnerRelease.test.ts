import { describe, expect, it } from 'vitest'
import { compareRunnerVersion, parseRunnerReleaseManifest } from './runnerRelease'

describe('runner release helpers', () => {
    it('compares stable runner versions', () => {
        expect(compareRunnerVersion('0.20.1', '0.20.2')).toBe('outdated')
        expect(compareRunnerVersion('0.20.2', '0.20.2')).toBe('current')
        expect(compareRunnerVersion('0.21.0', '0.20.2')).toBe('ahead')
        expect(compareRunnerVersion('dev', '0.20.2')).toBe('unknown')
    })

    it('accepts only a small stable release manifest', () => {
        expect(parseRunnerReleaseManifest({ version: 'v0.20.3', publishedAt: '2026-09-14T00:00:00Z' }))
            .toEqual({ version: '0.20.3', publishedAt: '2026-09-14T00:00:00Z' })
        expect(parseRunnerReleaseManifest({ version: '../../bad' })).toBeNull()
        expect(parseRunnerReleaseManifest('<html>')).toBeNull()
    })
})

