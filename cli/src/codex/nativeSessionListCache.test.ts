import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeCodexSessionListCache } from './nativeSessionListCache'

const cleanupPaths: string[] = []

afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true })
    }
})

function candidate(file: string) {
    const stats = statSync(file)
    return { file, modifiedAt: stats.mtimeMs, size: stats.size }
}

describe('NativeCodexSessionListCache', () => {
    it('reuses unchanged rows and applies a new watcher row without rescanning', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-list-cache-'))
        cleanupPaths.push(root)
        const oldId = '11111111-1111-4111-8111-111111111111'
        const newId = '22222222-2222-4222-8222-222222222222'
        const oldFile = join(root, `rollout-${oldId}.jsonl`)
        const newFile = join(root, `rollout-${newId}.jsonl`)
        mkdirSync(root, { recursive: true })
        writeFileSync(oldFile, '{"type":"session_meta"}\n', 'utf8')
        utimesSync(oldFile, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000))

        const readSummary = vi.fn((file: string, modifiedAt?: number) => {
            const id = file.includes(oldId) ? oldId : newId
            return {
                id,
                title: id === oldId ? 'Older task' : 'New task',
                cwd: '/work/project',
                file,
                modifiedAt: modifiedAt ?? 0,
                runState: 'idle' as const
            }
        })
        const cache = new NativeCodexSessionListCache({
            listFiles: () => [candidate(oldFile)],
            readSummary
        })

        expect(cache.list(1).map((session) => session.id)).toEqual([oldId])
        expect(cache.list(1).map((session) => session.id)).toEqual([oldId])
        expect(readSummary).toHaveBeenCalledTimes(1)

        writeFileSync(newFile, '{"type":"session_meta"}\n', 'utf8')
        const updated = cache.update(newFile, Date.now())

        expect(updated?.id).toBe(newId)
        expect(cache.list(2).map((session) => session.id)).toEqual([newId, oldId])
        // The watcher touched only the new row; the old transcript was not
        // re-read and the directory source was not invoked again.
        expect(readSummary).toHaveBeenCalledTimes(2)
    })

    it('rescans file metadata only for an explicit refresh', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-list-cache-'))
        cleanupPaths.push(root)
        const oldId = '33333333-3333-4333-8333-333333333333'
        const newId = '44444444-4444-4444-8444-444444444444'
        const oldFile = join(root, `rollout-${oldId}.jsonl`)
        const newFile = join(root, `rollout-${newId}.jsonl`)
        writeFileSync(oldFile, '{"type":"session_meta"}\n', 'utf8')
        utimesSync(oldFile, new Date(Date.now() - 1_000), new Date(Date.now() - 1_000))

        let files = [candidate(oldFile)]
        const listFiles = vi.fn(() => files)
        const readSummary = vi.fn((file: string, modifiedAt?: number) => {
            const id = file.includes(oldId) ? oldId : newId
            return {
                id,
                title: id,
                cwd: '/work/project',
                file,
                modifiedAt: modifiedAt ?? 0,
                runState: 'idle' as const
            }
        })
        const cache = new NativeCodexSessionListCache({ listFiles, readSummary })

        expect(cache.list(2).map((session) => session.id)).toEqual([oldId])
        writeFileSync(newFile, '{"type":"session_meta"}\n', 'utf8')
        files = [candidate(newFile), candidate(oldFile)]

        // Normal requests reuse the in-memory index rather than walking the
        // transcript tree again.
        expect(cache.list(2).map((session) => session.id)).toEqual([oldId])
        expect(listFiles).toHaveBeenCalledTimes(1)

        expect(cache.list(2, {}, { forceRefresh: true }).map((session) => session.id)).toEqual([newId, oldId])
        expect(listFiles).toHaveBeenCalledTimes(2)
        // Existing rows stay parsed; only the new transcript needs a read.
        expect(readSummary).toHaveBeenCalledTimes(2)
    })

    it('uses a resolved Codex thread title without reparsing the transcript', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-list-cache-'))
        cleanupPaths.push(root)
        const sessionId = '55555555-5555-4555-8555-555555555555'
        const file = join(root, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, '{"type":"session_meta"}\n', 'utf8')
        const resolveTitles = vi.fn(() => new Map([[sessionId, 'Codex own title']]))
        const cache = new NativeCodexSessionListCache({
            listFiles: () => [candidate(file)],
            readSummary: (filePath, modifiedAt) => ({
                id: sessionId,
                title: 'Transcript fallback title',
                cwd: '/work/project',
                file: filePath,
                modifiedAt: modifiedAt ?? 0
            }),
            resolveTitles
        })

        expect(cache.list(1)).toMatchObject([{ id: sessionId, title: 'Codex own title' }])
        expect(resolveTitles).toHaveBeenCalledWith([sessionId], { forceRefresh: undefined })
    })
})
