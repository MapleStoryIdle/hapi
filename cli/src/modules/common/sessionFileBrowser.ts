import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { SessionFileBrowserRequestSchema, type SessionFileBrowserResponse } from '@hapi/protocol/apiTypes'

const execute = promisify(execFile)
const inside = (root: string, target: string) => {
    const path = relative(root, target)
    return path !== '..' && !path.startsWith('../') && !path.startsWith('..\\') && !isAbsolute(path)
}

/** cwd is resolved from the native transcript by the Hub, never from a web request. */
export async function browseSessionFiles(cwd: string, request: unknown): Promise<SessionFileBrowserResponse> {
    const parsed = SessionFileBrowserRequestSchema.safeParse(request)
    if (!parsed.success || !cwd) return { success: false, error: 'Invalid file browser request' }
    try {
        const root = await realpath(cwd)
        const { action, path, staged } = parsed.data
        const target = resolve(root, path || '.')
        if (!inside(root, target)) return { success: false, error: 'Path outside session directory' }
        if (action === 'directory') {
            const canonical = await realpath(target)
            if (!inside(root, canonical)) return { success: false, error: 'Path outside session directory' }
            const all = await readdir(canonical, { withFileTypes: true })
            const sorted = all.filter(entry => !entry.isSymbolicLink() && entry.name !== '.git')
                .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
            const entries = []
            for (const entry of sorted.slice(0, 1000)) {
                const info = await stat(resolve(canonical, entry.name)).catch(() => null)
                entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const, size: info?.size })
            }
            return { success: true, entries, truncated: sorted.length > 1000 }
        }
        const git = async (args: string[]) => (await execute('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
            cwd: root, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
        })).stdout
        try { await git(['rev-parse', '--show-toplevel']) } catch (error) {
            if (error instanceof Error && /not a git repository/i.test(error.message)) return { success: true, isGitRepository: false }
            throw error
        }
        if (action === 'diff') {
            if (!path) return { success: false, error: 'Path is required' }
            return { success: true, stdout: await git(['diff', '--relative', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', relative(root, target)]) }
        }
        const [status, unstaged, index] = await Promise.all([
            git(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', '.']),
            git(['diff', '--relative', '--no-ext-diff', '--no-textconv', '--numstat', '--', '.']),
            git(['diff', '--relative', '--no-ext-diff', '--no-textconv', '--cached', '--numstat', '--', '.'])
        ])
        return { success: true, isGitRepository: true, status, unstaged, staged: index }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'File browser unavailable' }
    }
}
