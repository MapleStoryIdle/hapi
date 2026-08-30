import { describe, expect, test } from 'vitest'
import { resolveCommand } from './registry'

describe('share command registry', () => {
    test('registers share and makes the old conflicting command a tombstone', () => {
        expect(resolveCommand(['share', 'publish', 'note.md']).command.name).toBe('share')
        expect(resolveCommand(['artifact']).command.name).toBe('artifact')
    })
})
