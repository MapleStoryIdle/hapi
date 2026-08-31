import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSharePublishOptions, readShareSource } from './share'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function dir(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'hapi-share-')); dirs.push(value); return value }
describe('readShareSource', () => {
    test('reads a regular relative file and keeps basename only', async () => { const cwd = await dir(); await writeFile(join(cwd, 'note.txt'), 'hello'); await expect(readShareSource('note.txt', cwd)).resolves.toMatchObject({ filename: 'note.txt', bytes: expect.any(Uint8Array) }) })
    test('keeps non-ASCII basename safely', async () => { const cwd = await dir(); await writeFile(join(cwd, '报告.md'), 'safe'); await expect(readShareSource('报告.md', cwd)).resolves.toMatchObject({ filename: '报告.md' }) })
    test('rejects absolute, escaping, directories, and symlinks', async () => { const cwd = await dir(); await writeFile(join(cwd, 'file'), 'x'); await symlink(join(cwd, 'file'), join(cwd, 'link')); await expect(readShareSource('/tmp/x', cwd)).rejects.toThrow(); await expect(readShareSource('../x', cwd)).rejects.toThrow(); await expect(readShareSource('.', cwd)).rejects.toThrow(); await expect(readShareSource('link', cwd)).rejects.toThrow() })
})

describe('parseSharePublishOptions', () => {
    test('associates a Markdown task with its source session and optional feedback request', () => {
        expect(parseSharePublishOptions([
            'task.md',
            '--session', 'session-1',
            '--feedback',
            '--feedback-request', 'Review the rollout plan',
            '--expires', '600'
        ])).toEqual({
            path: 'task.md',
            expires: 600,
            sourceSessionId: 'session-1',
            sourceMachineId: null,
            feedback: true,
            feedbackRequest: 'Review the rollout plan'
        })
    })

    test('requires a source session whenever a one-time feedback contract is requested', () => {
        expect(() => parseSharePublishOptions(['task.md', '--feedback'])).toThrow('--feedback requires --session')
        expect(() => parseSharePublishOptions(['task.md', '--feedback-request', 'Review'])).toThrow('--feedback-request requires --feedback')
    })

    test('uses the current HAPI session as the source when invoked from a managed agent session', () => {
        expect(parseSharePublishOptions(['task.md', '--feedback'], 'inherited-session')).toMatchObject({
            sourceSessionId: 'inherited-session',
            sourceMachineId: null,
            feedback: true
        })
    })

    test('keeps an explicit runner as native-session disambiguation', () => {
        expect(parseSharePublishOptions(['task.md', '--session', 'native-session', '--machine', 'runner-1', '--feedback'])).toMatchObject({
            sourceSessionId: 'native-session',
            sourceMachineId: 'runner-1',
            feedback: true
        })
    })
})
