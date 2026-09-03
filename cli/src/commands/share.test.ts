import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { encodeShareSourceContextHeaders, getShareSourceContext, parseSharePublishOptions, readShareSource } from './share'

const dirs: string[] = []
const execFileAsync = promisify(execFile)
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function dir(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'hapi-share-')); dirs.push(value); return value }
describe('readShareSource', () => {
    test('reads a regular relative file and keeps basename only', async () => { const cwd = await dir(); await writeFile(join(cwd, 'note.txt'), 'hello'); await expect(readShareSource('note.txt', cwd)).resolves.toMatchObject({ filename: 'note.txt', bytes: expect.any(Uint8Array) }) })
    test('keeps non-ASCII basename safely', async () => { const cwd = await dir(); await writeFile(join(cwd, '报告.md'), 'safe'); await expect(readShareSource('报告.md', cwd)).resolves.toMatchObject({ filename: '报告.md' }) })
    test('rejects absolute, escaping, directories, and symlinks', async () => { const cwd = await dir(); await writeFile(join(cwd, 'file'), 'x'); await symlink(join(cwd, 'file'), join(cwd, 'link')); await expect(readShareSource('/tmp/x', cwd)).rejects.toThrow(); await expect(readShareSource('../x', cwd)).rejects.toThrow(); await expect(readShareSource('.', cwd)).rejects.toThrow(); await expect(readShareSource('link', cwd)).rejects.toThrow() })
})

describe('share source context', () => {
    test('uses the invoked directory basename and current Git branch without leaking the path', async () => {
        const cwd = await dir()
        await execFileAsync('git', ['init', '--quiet', '--initial-branch=share-context'], { cwd })
        const previousInvokedCwd = process.env.HAPI_INVOKED_CWD
        process.env.HAPI_INVOKED_CWD = cwd
        try {
            const context = await getShareSourceContext()
            if (!context) throw new Error('Expected source context')
            const headers = encodeShareSourceContextHeaders(context)
            expect(context).toEqual({ directoryName: basename(cwd), gitBranch: 'share-context' })
            expect(Buffer.from(headers['x-hapi-share-source-directory']!, 'base64url').toString('utf8')).toBe(basename(cwd))
            expect(Buffer.from(headers['x-hapi-share-source-branch']!, 'base64url').toString('utf8')).toBe('share-context')
            expect(JSON.stringify(context)).not.toContain(cwd)
            expect(Buffer.from(headers['x-hapi-share-source-directory']!, 'base64url').toString('utf8')).not.toContain(cwd)
        } finally {
            if (previousInvokedCwd === undefined) delete process.env.HAPI_INVOKED_CWD
            else process.env.HAPI_INVOKED_CWD = previousInvokedCwd
        }
    })

    test('keeps publishing context when the invoked directory is not a Git repository', async () => {
        const cwd = await dir()
        const context = await getShareSourceContext(cwd)
        if (!context) throw new Error('Expected source context')
        const headers = encodeShareSourceContextHeaders(context)
        expect(context).toEqual({ directoryName: basename(cwd), gitBranch: null })
        expect(headers).toEqual({
            'x-hapi-share-source-directory': Buffer.from(basename(cwd), 'utf8').toString('base64url')
        })
    })

    test('omits source context instead of blocking a share when the directory has no safe basename', async () => {
        await expect(getShareSourceContext(parse(process.cwd()).root)).resolves.toBeNull()
    })

    test('ignores Git environment overrides and reads the invoked directory repository', async () => {
        const cwd = await dir()
        const other = await dir()
        await execFileAsync('git', ['init', '--quiet', '--initial-branch=invoked-branch'], { cwd })
        await execFileAsync('git', ['init', '--quiet', '--initial-branch=wrong-branch'], { cwd: other })
        const previousGitDir = process.env.GIT_DIR
        process.env.GIT_DIR = join(other, '.git')
        try {
            await expect(getShareSourceContext(cwd)).resolves.toEqual({
                directoryName: basename(cwd),
                gitBranch: 'invoked-branch'
            })
        } finally {
            if (previousGitDir === undefined) delete process.env.GIT_DIR
            else process.env.GIT_DIR = previousGitDir
        }
    })
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

    test('uses the current SHAPI session as the source when invoked from a managed agent session', () => {
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
