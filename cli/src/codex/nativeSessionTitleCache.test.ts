import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeCodexSessionTitleCache } from './nativeSessionTitleCache'

const cleanupPaths: string[] = []

afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true })
    }
})

function createStateDatabaseFile(root: string): string {
    mkdirSync(root, { recursive: true })
    const path = join(root, 'state_5.sqlite')
    writeFileSync(path, '', 'utf8')
    return path
}

describe('NativeCodexSessionTitleCache', () => {
    it('uses the cached Codex state title and does not request a preview field', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-codex-title-'))
        cleanupPaths.push(codexHome)
        const namedId = '11111111-1111-4111-8111-111111111111'
        const titledId = '22222222-2222-4222-8222-222222222222'
        const databasePath = createStateDatabaseFile(codexHome)
        const readTitles = vi.fn((_path: string, sessionIds: readonly string[]) => {
            expect(_path).toBe(databasePath)
            expect(sessionIds).toEqual([namedId, titledId, 'missing'])
            return new Map([
                [namedId, 'My named task'],
                [titledId, 'Codex task title']
            ])
        })
        const cache = new NativeCodexSessionTitleCache({
            getCodexHome: () => codexHome,
            readTitles
        })
        const titles = cache.resolve([namedId, titledId, 'missing'])

        expect(titles).toEqual(new Map([
            [namedId, 'My named task'],
            [titledId, 'Codex task title']
        ]))
        expect(cache.resolve([namedId, titledId])).toEqual(new Map([
            [namedId, 'My named task'],
            [titledId, 'Codex task title']
        ]))
        expect(readTitles).toHaveBeenCalledTimes(1)
    })

    it('reloads titles when explicitly refreshed', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-codex-title-'))
        cleanupPaths.push(codexHome)
        const sessionId = '44444444-4444-4444-8444-444444444444'
        createStateDatabaseFile(codexHome)
        let title = 'First title'
        const readTitles = vi.fn(() => new Map([[sessionId, title]]))
        const cache = new NativeCodexSessionTitleCache({ getCodexHome: () => codexHome, readTitles })

        expect(cache.resolve([sessionId]).get(sessionId)).toBe('First title')
        title = 'Renamed in Codex'
        expect(cache.resolve([sessionId]).get(sessionId)).toBe('First title')
        expect(cache.resolve([sessionId], { forceRefresh: true }).get(sessionId)).toBe('Renamed in Codex')
        expect(readTitles).toHaveBeenCalledTimes(2)
    })

    it('retries a failed state database read instead of caching sessions as untitled', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-codex-title-'))
        cleanupPaths.push(codexHome)
        const sessionId = '55555555-5555-4555-8555-555555555555'
        const databasePath = createStateDatabaseFile(codexHome)
        let databaseAvailable = false
        const readTitles = vi.fn((_path: string, _sessionIds: readonly string[]) => {
            return databaseAvailable ? new Map([[sessionId, 'Recovered Codex title']]) : null
        })
        const cache = new NativeCodexSessionTitleCache({ getCodexHome: () => codexHome, readTitles })

        expect(cache.resolve([sessionId])).toEqual(new Map())
        expect(readTitles).toHaveBeenCalledWith(databasePath, [sessionId])

        databaseAvailable = true
        expect(cache.resolve([sessionId])).toEqual(new Map([[sessionId, 'Recovered Codex title']]))
        expect(readTitles).toHaveBeenCalledTimes(2)
    })

    it('keeps a confirmed missing state title cached', () => {
        const codexHome = mkdtempSync(join(tmpdir(), 'hapi-native-codex-title-'))
        cleanupPaths.push(codexHome)
        const sessionId = '66666666-6666-4666-8666-666666666666'
        createStateDatabaseFile(codexHome)
        const readTitles = vi.fn(() => new Map<string, string>())
        const cache = new NativeCodexSessionTitleCache({ getCodexHome: () => codexHome, readTitles })

        expect(cache.resolve([sessionId])).toEqual(new Map())
        expect(cache.resolve([sessionId])).toEqual(new Map())
        expect(readTitles).toHaveBeenCalledTimes(1)
    })
})
