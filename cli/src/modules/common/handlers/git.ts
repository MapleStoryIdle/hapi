import { execFile, type ExecFileOptions } from 'child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'util'
import type { CommandResponse, GitBranchResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { rpcError } from '../rpcResponses'

const execFileAsync = promisify(execFile)

interface GitStatusRequest {
    cwd?: string
    timeout?: number
}

interface GitDiffNumstatRequest {
    cwd?: string
    staged?: boolean
    timeout?: number
}

interface GitDiffFileRequest {
    cwd?: string
    filePath: string
    staged?: boolean
    timeout?: number
}

type GitCommandResponse = CommandResponse

function resolveCwd(requestedCwd: string | undefined, workingDirectory: string): { cwd: string; error?: string } {
    const cwd = requestedCwd ?? workingDirectory
    const validation = validatePath(cwd, workingDirectory)
    if (!validation.valid) {
        return { cwd, error: validation.error ?? 'Invalid working directory' }
    }
    return { cwd }
}

function validateFilePath(filePath: string, workingDirectory: string): string | null {
    const validation = validatePath(filePath, workingDirectory)
    if (!validation.valid) {
        return validation.error ?? 'Invalid file path'
    }
    return null
}

async function runGitCommand(
    args: string[],
    cwd: string,
    timeout?: number
): Promise<GitCommandResponse> {
    try {
        const options: ExecFileOptions = {
            cwd,
            timeout: timeout ?? 10_000
        }
        const { stdout, stderr } = await execFileAsync('git', args, options)
        return {
            success: true,
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : '',
            exitCode: 0
        }
    } catch (error) {
        const execError = error as NodeJS.ErrnoException & {
            stdout?: string
            stderr?: string
            code?: number | string
            killed?: boolean
        }

        if (execError.code === 'ETIMEDOUT' || execError.killed) {
            return rpcError('Command timed out', {
                stdout: execError.stdout ? execError.stdout.toString() : '',
                stderr: execError.stderr ? execError.stderr.toString() : '',
                exitCode: typeof execError.code === 'number' ? execError.code : -1
            })
        }

        return rpcError(execError.message || 'Command failed', {
            stdout: execError.stdout ? execError.stdout.toString() : '',
            stderr: execError.stderr ? execError.stderr.toString() : execError.message || 'Command failed',
            exitCode: typeof execError.code === 'number' ? execError.code : 1
        })
    }
}

/** Return complete status for the Files view. */
export async function getGitStatusForCwd(cwd: string, timeout?: number): Promise<GitCommandResponse> {
    return await runGitCommand(
        ['status', '--porcelain=v2', '--branch', '--untracked-files=all'],
        cwd,
        timeout
    )
}

/**
 * `git rev-parse --git-dir --git-common-dir` uses different directories for
 * a linked worktree. The primary checkout reports the same directory twice.
 */
export function isLinkedGitWorktree(gitDirectoriesOutput: string, cwd: string): boolean {
    const [rawGitDir = '', rawCommonDir = ''] = gitDirectoriesOutput
        .split(/\r?\n/)
        .map((value) => value.trim())
    if (!rawGitDir || !rawCommonDir) {
        return false
    }

    const normalize = (path: string) => {
        const resolved = isAbsolute(path) ? path : resolve(cwd, path)
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved
    }
    return normalize(rawGitDir) !== normalize(rawCommonDir)
}

export function hasGitWorktreeChanges(statusOutput: string): boolean {
    return statusOutput
        .split(/\r?\n/)
        .some((line) => line.length > 0 && !line.startsWith('# '))
}

/**
 * Read the checked-out branch and dirty state for a project-list subtitle.
 * The web caches this result by machine + directory, so multiple session cards
 * for one project share a single probe.
 */
export async function getGitBranchStatusForCwd(cwd: string, timeout?: number): Promise<GitBranchResponse> {
    const [status, gitDirectories] = await Promise.all([
        runGitCommand(
            ['status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
            cwd,
            timeout
        ),
        runGitCommand(
            ['rev-parse', '--git-dir', '--git-common-dir'],
            cwd,
            timeout
        )
    ])
    if (!status.success) return status

    return {
        ...status,
        isWorktree: gitDirectories.success
            ? isLinkedGitWorktree(gitDirectories.stdout ?? '', cwd)
            : false,
        isDirty: hasGitWorktreeChanges(status.stdout ?? '')
    }
}

export function registerGitHandlers(rpcHandlerManager: RpcHandlerManager, workingDirectory: string): void {
    rpcHandlerManager.registerHandler<GitStatusRequest, GitCommandResponse>(RPC_METHODS.GitStatus, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        return await getGitStatusForCwd(resolved.cwd, data.timeout)
    })

    rpcHandlerManager.registerHandler<GitDiffNumstatRequest, GitCommandResponse>(RPC_METHODS.GitDiffNumstat, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        const args = data.staged
            ? ['diff', '--cached', '--numstat']
            : ['diff', '--numstat']
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })

    rpcHandlerManager.registerHandler<GitDiffFileRequest, GitCommandResponse>(RPC_METHODS.GitDiffFile, async (data) => {
        const resolved = resolveCwd(data.cwd, workingDirectory)
        if (resolved.error) {
            return rpcError(resolved.error)
        }
        const fileError = validateFilePath(data.filePath, workingDirectory)
        if (fileError) {
            return rpcError(fileError)
        }

        const args = data.staged
            ? ['diff', '--cached', '--no-ext-diff', '--', data.filePath]
            : ['diff', '--no-ext-diff', '--', data.filePath]
        return await runGitCommand(args, resolved.cwd, data.timeout)
    })
}
