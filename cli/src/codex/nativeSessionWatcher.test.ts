import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    getCodexSessionIdFromTranscriptPath,
    NativeCodexSessionWatcher
} from './nativeSessionWatcher'

const cleanupPaths: string[] = []

afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
        rmSync(path, { recursive: true, force: true })
    }
})

function waitForChange(check: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + 500
        const attempt = () => {
            try {
                check()
                resolve()
            } catch (error) {
                if (Date.now() >= deadline) {
                    reject(error)
                    return
                }
                setTimeout(attempt, 5)
            }
        }
        attempt()
    })
}

describe('NativeCodexSessionWatcher', () => {
    it('extracts a native Codex thread id from a rollout path', () => {
        expect(getCodexSessionIdFromTranscriptPath(
            '/Users/alice/.codex/sessions/2026/08/28/rollout-12345678-1234-4234-8234-123456789012.jsonl'
        )).toBe('12345678-1234-4234-8234-123456789012')
        expect(getCodexSessionIdFromTranscriptPath(
            '/Users/alice/.codex/sessions/2026/08/28/rollout-2026-08-28T10-20-30-abcdefab-cdef-4def-8def-abcdefabcdef.jsonl'
        )).toBe('abcdefab-cdef-4def-8def-abcdefabcdef')
        expect(getCodexSessionIdFromTranscriptPath(
            '/Users/alice/.codex/sessions/2026/09/04/' +
            'rollout-2026-09-04T18-04-48-abcdefab-cdef-4def-8def-abcdefabcdef_' +
            '12345678-1234-4234-8234-123456789012.jsonl'
        )).toBe('abcdefab-cdef-4def-8def-abcdefabcdef')
        expect(getCodexSessionIdFromTranscriptPath('/tmp/not-a-rollout.jsonl')).toBeNull()
    })

    it('emits one debounced lightweight invalidation for a changed transcript', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-watcher-'))
        cleanupPaths.push(root)
        const sessionId = '12345678-1234-4234-8234-123456789012'
        const file = join(root, '2026', '08', '28', `rollout-2026-08-28T10-20-30-${sessionId}.jsonl`)
        mkdirSync(join(root, '2026', '08', '28'), { recursive: true })
        writeFileSync(file, '{"type":"session_meta"}\n', 'utf-8')

        const callbacks = new Map<string, () => void>()
        const changes: Array<{ codexSessionId: string; filePath: string; modifiedAt: number }> = []
        const watcher = new NativeCodexSessionWatcher({
            root,
            debounceMs: 1,
            discoveryIntervalMs: 10,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: (change) => changes.push(change)
        })

        try {
            watcher.start()
            watcher.observeTranscript(file, sessionId)
            writeFileSync(file, '{"type":"session_meta"}\n{"type":"event_msg"}\n', 'utf-8')
            callbacks.get(file)?.()
            callbacks.get(file)?.()

            await waitForChange(() => expect(changes).toHaveLength(1))
            expect(changes[0]?.codexSessionId).toBe(sessionId)
            expect(changes[0]?.filePath).toBe(file)
            expect(changes[0]?.modifiedAt).toBeGreaterThan(0)
            // The periodic discovery scan sees the same file too, but must
            // not turn one write into a delayed duplicate invalidation.
            await new Promise((resolve) => setTimeout(resolve, 30))
            expect(changes).toHaveLength(1)
        } finally {
            watcher.stop()
        }
    })

    it('does not emit a pending invalidation after it is stopped', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-watcher-stop-'))
        cleanupPaths.push(root)
        const sessionId = 'abcdefab-cdef-4def-8def-abcdefabcdef'
        const file = join(root, `rollout-${sessionId}.jsonl`)
        writeFileSync(file, '{"type":"session_meta"}\n', 'utf-8')

        const callbacks = new Map<string, () => void>()
        const changes: Array<{ codexSessionId: string; filePath: string; modifiedAt: number }> = []
        const watcher = new NativeCodexSessionWatcher({
            root,
            debounceMs: 20,
            discoveryIntervalMs: 60_000,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: (change) => changes.push(change)
        })

        watcher.start()
        watcher.observeTranscript(file, sessionId)
        callbacks.get(file)?.()
        watcher.stop()
        await new Promise((resolve) => setTimeout(resolve, 30))

        expect(changes).toEqual([])
    })

    it('does not open file watchers for dormant transcripts', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-recent-window-'))
        cleanupPaths.push(root)
        const callbacks = new Map<string, () => void>()
        const watcher = new NativeCodexSessionWatcher({
            root,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: () => {}
        })

        for (let index = 0; index < 65; index += 1) {
            const sessionId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
            writeFileSync(join(root, `rollout-${sessionId}.jsonl`), '{"type":"session_meta"}\n', 'utf-8')
        }

        try {
            watcher.start()
            expect(callbacks.size).toBe(0)
        } finally {
            watcher.stop()
        }
    })

    it('discovers a changed older transcript on the periodic scan', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-polling-'))
        cleanupPaths.push(root)
        const olderSessionId = '11111111-1111-4111-8111-111111111111'
        const recentSessionId = '22222222-2222-4222-8222-222222222222'
        const olderFile = join(root, `rollout-${olderSessionId}.jsonl`)
        const recentFile = join(root, `rollout-${recentSessionId}.jsonl`)
        writeFileSync(olderFile, '{"type":"session_meta"}\n', 'utf-8')
        writeFileSync(recentFile, '{"type":"session_meta"}\n', 'utf-8')
        const now = Date.now()
        utimesSync(olderFile, new Date(now - 10_000), new Date(now - 10_000))
        utimesSync(recentFile, new Date(now), new Date(now))

        const callbacks = new Map<string, () => void>()
        const changes: Array<{ codexSessionId: string }> = []
        const watcher = new NativeCodexSessionWatcher({
            root,
            discoveryIntervalMs: 10,
            debounceMs: 1,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: (change) => changes.push(change)
        })

        try {
            watcher.start()
            expect(callbacks.has(olderFile)).toBe(false)

            writeFileSync(olderFile, '{"type":"session_meta"}\n{"type":"event_msg"}\n', 'utf-8')

            await waitForChange(() => {
                expect(changes.map((change) => change.codexSessionId)).toContain(olderSessionId)
            })
            expect(callbacks.has(olderFile)).toBe(false)
        } finally {
            watcher.stop()
        }
    })

    it('keeps an observed older transcript on the low-latency watcher set', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-observe-'))
        cleanupPaths.push(root)
        const oldSessionId = '11111111-1111-4111-8111-111111111111'
        const recentSessionId = '22222222-2222-4222-8222-222222222222'
        const oldFile = join(root, `rollout-${oldSessionId}.jsonl`)
        const recentFile = join(root, `rollout-${recentSessionId}.jsonl`)
        writeFileSync(oldFile, '{"type":"session_meta"}\n', 'utf-8')
        writeFileSync(recentFile, '{"type":"session_meta"}\n', 'utf-8')
        const now = Date.now()
        utimesSync(oldFile, new Date(now - 10_000), new Date(now - 10_000))
        utimesSync(recentFile, new Date(now), new Date(now))

        const callbacks = new Map<string, () => void>()
        const changes: Array<{ codexSessionId: string; filePath: string; modifiedAt: number }> = []
        const watcher = new NativeCodexSessionWatcher({
            root,
            debounceMs: 1,
            discoveryIntervalMs: 60_000,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: (change) => changes.push(change)
        })

        try {
            watcher.start()
            expect(callbacks.has(oldFile)).toBe(false)

            watcher.observeTranscript(oldFile, oldSessionId)
            expect(callbacks.has(oldFile)).toBe(true)
            callbacks.get(oldFile)?.()

            await waitForChange(() => expect(changes).toHaveLength(1))
            expect(changes[0]?.codexSessionId).toBe(oldSessionId)
        } finally {
            watcher.stop()
        }
    })

    it('releases the least recently observed transcript watcher', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-native-codex-observe-limit-'))
        cleanupPaths.push(root)
        const firstId = '11111111-1111-4111-8111-111111111111'
        const secondId = '22222222-2222-4222-8222-222222222222'
        const firstFile = join(root, `rollout-${firstId}.jsonl`)
        const secondFile = join(root, `rollout-${secondId}.jsonl`)
        writeFileSync(firstFile, '{"type":"session_meta"}\n', 'utf-8')
        writeFileSync(secondFile, '{"type":"session_meta"}\n', 'utf-8')

        const callbacks = new Map<string, () => void>()
        const watcher = new NativeCodexSessionWatcher({
            root,
            maxObservedTranscripts: 1,
            watchFile: (filePath, onChange) => {
                callbacks.set(filePath, onChange)
                return () => callbacks.delete(filePath)
            },
            onChange: () => {}
        })

        try {
            watcher.start()
            watcher.observeTranscript(firstFile, firstId)
            watcher.observeTranscript(secondFile, secondId)

            expect(callbacks.has(firstFile)).toBe(false)
            expect(callbacks.has(secondFile)).toBe(true)
        } finally {
            watcher.stop()
        }
    })
})
