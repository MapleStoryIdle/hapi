import { describe, expect, test } from 'vitest'
import { resolveCommand } from './registry'
import { resolveRunnerCommand } from './runnerRegistry'

describe('share command registry', () => {
    test('registers share and makes the old conflicting command a tombstone', () => {
        expect(resolveCommand(['share', 'publish', 'note.md']).command.name).toBe('share')
        expect(resolveCommand(['artifact']).command.name).toBe('artifact')
    })
})

describe('workspace command registry', () => {
    test('registers workspace as a first-class command', () => {
        expect(resolveCommand(['workspace', 'register', 'Home']).command.name).toBe('workspace')
    })
})

describe('runner-only command registry', () => {
    test('keeps runner commands and replaces hub commands with an unavailable command', () => {
        expect(resolveRunnerCommand(['runner', 'status']).command.name).toBe('runner')
        expect(resolveRunnerCommand(['workspace', 'register']).command.name).toBe('workspace')
        expect(resolveRunnerCommand(['hub']).command.requiresRuntimeAssets).toBe(false)
        expect(resolveRunnerCommand(['server']).command.requiresRuntimeAssets).toBe(false)
    })
})
