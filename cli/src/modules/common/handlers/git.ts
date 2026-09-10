import { execFile, type ExecFileOptions } from 'child_process'
import { isAbsolute, resolve } from 'node:path'
import { promisify } from 'util'
import type {
    CommandResponse,
    GitBranchOption,
    GitBranchResponse,
    GitBranchesResponse,
    MachineGitBranchCreateRequest,
    MachineGitBranchCommitRequest,
    MachineGitBranchSwitchRequest
} from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { rpcError } from '../rpcResponses'
import { runnerGitChildRepositoryCache } from '../gitChildRepositories'

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

const GIT_BRANCH_FETCH_TIMEOUT_MS = 30_000
const GIT_BRANCH_REMOTE_TIMEOUT_MS = 60_000

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
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
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
    const gitDirectories = await runGitCommand(['rev-parse', '--git-dir', '--git-common-dir'], cwd, timeout)
    if (!gitDirectories.success) {
        if (isConfirmedNonGitDirectory(gitDirectories)) {
            return { success: true, repositoryState: 'non-git', ...await runnerGitChildRepositoryCache.get(cwd) }
        }
        return { ...gitDirectories, repositoryState: 'error' }
    }
    const status = await runGitCommand(['status', '--porcelain=v2', '--branch', '--untracked-files=normal'], cwd, timeout)
    if (!status.success) return { ...status, repositoryState: 'error' }

    return {
        ...status,
        repositoryState: 'git',
        isWorktree: isLinkedGitWorktree(gitDirectories.stdout ?? '', cwd),
        isDirty: hasGitWorktreeChanges(status.stdout ?? '')
    }
}

export function isConfirmedNonGitDirectory(result: GitCommandResponse): boolean {
    return !result.success && result.exitCode === 128
        && /^fatal: not a git repository \(or any (?:of the parent directories|parent up to mount point [^\r\n]+)\)(?:: \.git)?\r?$/m.test(result.stderr ?? '')
}

function gitBranchFailure(
    result: GitCommandResponse,
    code?: GitBranchesResponse['code']
): GitBranchesResponse {
    return {
        success: false,
        error: result.error ?? result.stderr ?? 'Git command failed',
        ...(code ? { code } : {})
    }
}

function splitGitLines(output: string | undefined): string[] {
    return (output ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
}

function parseGitNumstat(output: string | undefined): { additions: number; deletions: number } {
    let additions = 0
    let deletions = 0

    for (const line of splitGitLines(output)) {
        const [added, removed] = line.split('\t')
        const addedCount = Number.parseInt(added ?? '', 10)
        const removedCount = Number.parseInt(removed ?? '', 10)
        if (Number.isFinite(addedCount)) additions += addedCount
        if (Number.isFinite(removedCount)) deletions += removedCount
    }

    return { additions, deletions }
}

function getRemoteBranchOption(ref: string): GitBranchOption | null {
    const separator = ref.indexOf('/')
    if (separator <= 0 || separator === ref.length - 1) return null

    const name = ref.slice(separator + 1)
    if (name === 'HEAD') return null

    // `ref` is retained for the RPC mutation. The UI intentionally only
    // receives `name`, so a conventional `origin/` prefix never leaks into
    // the branch list.
    return { ref, name }
}

function countChangedFiles(statusOutput: string | undefined): number {
    return splitGitLines(statusOutput).length
}

function getDefaultPushRemote(output: string | undefined): string | null {
    const remotes = splitGitLines(output)
    if (remotes.includes('origin')) return 'origin'
    return remotes.length === 1 ? remotes[0] ?? null : null
}

function getRemoteNameFromUpstream(upstream: string | null | undefined): string | null {
    if (!upstream) return null
    const separator = upstream.indexOf('/')
    return separator > 0 ? upstream.slice(0, separator) : null
}

function isNotGitRepository(result: GitCommandResponse): boolean {
    return /not a git repository/i.test(`${result.error ?? ''}\n${result.stderr ?? ''}`)
}

/**
 * Read the complete branch picker payload in a bounded number of lightweight
 * Git calls. This is a machine-level helper so original Codex and SHAPI
 * sessions can share exactly the same branch controls.
 */
export async function getGitBranchesForCwd(cwd: string): Promise<GitBranchesResponse> {
    const repository = await runGitCommand(['rev-parse', '--is-inside-work-tree'], cwd)
    if (!repository.success || repository.stdout?.trim() !== 'true') {
        return gitBranchFailure(repository, isNotGitRepository(repository) ? 'not_git_repository' : undefined)
    }

    const [current, status, numstat, local, remote, remoteNames, upstream] = await Promise.all([
        runGitCommand(['branch', '--show-current'], cwd),
        runGitCommand(['status', '--porcelain=v1', '--untracked-files=all'], cwd),
        // Comparing with HEAD covers staged and unstaged tracked changes in
        // one pass. An unborn repository simply has no line totals yet.
        runGitCommand(['diff', '--numstat', 'HEAD'], cwd),
        runGitCommand(['for-each-ref', '--format=%(refname:short)', '--sort=refname', 'refs/heads'], cwd),
        runGitCommand(['for-each-ref', '--format=%(refname:short)', '--sort=refname', 'refs/remotes'], cwd),
        runGitCommand(['remote'], cwd),
        runGitCommand(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd)
    ])

    if (!status.success) return gitBranchFailure(status)
    if (!local.success) return gitBranchFailure(local)
    if (!remote.success) return gitBranchFailure(remote)

    const { additions, deletions } = numstat.success
        ? parseGitNumstat(numstat.stdout)
        : { additions: 0, deletions: 0 }
    const currentBranch = current.success && current.stdout?.trim()
        ? current.stdout.trim()
        : null
    const upstreamBranch = upstream.success && upstream.stdout?.trim()
        ? upstream.stdout.trim()
        : null
    const changedFileCount = countChangedFiles(status.stdout)
    const isDirty = changedFileCount > 0

    return {
        success: true,
        currentBranch,
        pushRemote: remoteNames.success ? getDefaultPushRemote(remoteNames.stdout) : null,
        upstream: upstreamBranch,
        canUpdate: Boolean(currentBranch && upstreamBranch && !isDirty),
        isDirty,
        changedFileCount,
        additions,
        deletions,
        localBranches: splitGitLines(local.stdout).map((name) => ({ ref: name, name })),
        remoteBranches: splitGitLines(remote.stdout)
            .map(getRemoteBranchOption)
            .filter((branch): branch is GitBranchOption => branch !== null)
    }
}

async function validateGitBranchName(cwd: string, name: string): Promise<GitCommandResponse> {
    return await runGitCommand(['check-ref-format', '--branch', name], cwd)
}

function branchOperationFailure(result: GitCommandResponse): GitBranchesResponse {
    return {
        success: false,
        error: result.error ?? result.stderr ?? 'Git branch operation failed'
    }
}

async function switchToLocalBranch(cwd: string, branch: GitBranchOption): Promise<GitBranchesResponse> {
    const valid = await validateGitBranchName(cwd, branch.ref)
    if (!valid.success) return branchOperationFailure(valid)

    const switched = await runGitCommand(['switch', branch.ref], cwd)
    if (!switched.success) return branchOperationFailure(switched)
    return await getGitBranchesForCwd(cwd)
}

/**
 * Switch without force, reset, or stash. A dirty worktree must be explicitly
 * confirmed by the browser and is checked here again to prevent a race.
 */
export async function switchGitBranchForCwd(
    cwd: string,
    request: Pick<MachineGitBranchSwitchRequest, 'target' | 'confirmDirty'>
): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches

    const localBranches = branches.localBranches ?? []
    const remoteBranches = branches.remoteBranches ?? []
    const target = request.target.kind === 'local'
        ? localBranches.find((branch) => branch.ref === request.target.ref)
        : remoteBranches.find((branch) => branch.ref === request.target.ref)
    if (!target) {
        return { ...branches, success: false, code: 'branch_not_found', error: 'Git branch was not found' }
    }
    const existingLocalBranch = request.target.kind === 'remote'
        ? localBranches.find((branch) => branch.name === target.name)
        : null
    if (
        (request.target.kind === 'local' && target.ref === branches.currentBranch)
        || existingLocalBranch?.ref === branches.currentBranch
    ) {
        return branches
    }
    if (branches.isDirty && request.confirmDirty !== true) {
        return {
            ...branches,
            success: false,
            code: 'dirty_confirmation_required',
            error: 'Working tree has uncommitted changes'
        }
    }

    if (request.target.kind === 'local') {
        return await switchToLocalBranch(cwd, target)
    }

    // A matching local branch is the already-pulled version requested by the
    // UI contract. Prefer it before hitting the network.
    if (existingLocalBranch) {
        return await switchToLocalBranch(cwd, existingLocalBranch)
    }

    const remoteSeparator = target.ref.indexOf('/')
    const remoteName = target.ref.slice(0, remoteSeparator)
    const remoteBranchName = target.ref.slice(remoteSeparator + 1)
    const fetched = await runGitCommand(['fetch', '--prune', remoteName], cwd, GIT_BRANCH_FETCH_TIMEOUT_MS)
    if (!fetched.success) return branchOperationFailure(fetched)

    const refreshed = await getGitBranchesForCwd(cwd)
    if (!refreshed.success) return refreshed
    const refreshedRemote = (refreshed.remoteBranches ?? []).find((branch) => branch.ref === target.ref)
    if (!refreshedRemote) {
        return {
            ...refreshed,
            success: false,
            code: 'branch_not_found',
            error: 'Git branch was not found after fetch'
        }
    }

    const racedLocalBranch = (refreshed.localBranches ?? []).find((branch) => branch.name === remoteBranchName)
    if (racedLocalBranch) {
        return await switchToLocalBranch(cwd, racedLocalBranch)
    }

    const valid = await validateGitBranchName(cwd, remoteBranchName)
    if (!valid.success) return branchOperationFailure(valid)
    const switched = await runGitCommand(['switch', '--track', '-c', remoteBranchName, refreshedRemote.ref], cwd)
    if (!switched.success) return branchOperationFailure(switched)
    return await getGitBranchesForCwd(cwd)
}

/** Create and check out a new branch from the current HEAD without touching
 * the worktree contents. */
export async function createGitBranchForCwd(
    cwd: string,
    request: Pick<MachineGitBranchCreateRequest, 'name'>
): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches

    if ((branches.localBranches ?? []).some((branch) => branch.name === request.name)) {
        return { ...branches, success: false, code: 'branch_exists', error: 'Git branch already exists' }
    }

    const valid = await validateGitBranchName(cwd, request.name)
    if (!valid.success) return branchOperationFailure(valid)
    const created = await runGitCommand(['switch', '-c', request.name], cwd)
    if (!created.success) return branchOperationFailure(created)
    return await getGitBranchesForCwd(cwd)
}

/**
 * Commit the full current worktree intentionally, without bypassing Git hooks.
 * The runner receives a typed request, and every command is passed as an
 * `execFile` argument so a commit message cannot become shell syntax.
 */
export async function commitGitChangesForCwd(
    cwd: string,
    request: Pick<MachineGitBranchCommitRequest, 'message'>
): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches
    if (!branches.isDirty) {
        return {
            ...branches,
            success: false,
            code: 'nothing_to_commit',
            error: 'There are no local changes to commit'
        }
    }

    const staged = await runGitCommand(['add', '--all'], cwd)
    if (!staged.success) return branchOperationFailure(staged)

    const committed = await runGitCommand(['commit', '-m', request.message], cwd, GIT_BRANCH_REMOTE_TIMEOUT_MS)
    if (!committed.success) return branchOperationFailure(committed)
    return await getGitBranchesForCwd(cwd)
}

/**
 * Push a branch only through an existing upstream. For a newly created local
 * branch, use `origin` when it exists, otherwise use the single configured
 * remote. Ambiguous remote configurations are left for the user to configure.
 */
export async function pushGitBranchForCwd(
    cwd: string
): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches
    if (!branches.currentBranch) {
        return {
            ...branches,
            success: false,
            code: 'detached_head',
            error: 'Cannot push while HEAD is detached'
        }
    }

    const upstream = await runGitCommand(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        cwd
    )
    const pushArgs = upstream.success
        ? ['push']
        : branches.pushRemote
            ? ['push', '--set-upstream', branches.pushRemote, branches.currentBranch]
            : null
    if (!pushArgs) {
        return {
            ...branches,
            success: false,
            code: 'push_remote_unavailable',
            error: 'No default Git remote is available for this branch'
        }
    }

    const pushed = await runGitCommand(pushArgs, cwd, GIT_BRANCH_REMOTE_TIMEOUT_MS)
    if (!pushed.success) return branchOperationFailure(pushed)
    return await getGitBranchesForCwd(cwd)
}

/**
 * Fetch only the remote that backs the checked-out branch when known. This
 * updates remote refs but intentionally leaves the user's worktree untouched.
 */
export async function fetchGitBranchesForCwd(cwd: string): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches

    const remote = getRemoteNameFromUpstream(branches.upstream) ?? branches.pushRemote
    if (!remote) {
        return {
            ...branches,
            success: false,
            code: 'fetch_remote_unavailable',
            error: 'No Git remote is available to fetch'
        }
    }

    const fetched = await runGitCommand(['fetch', '--prune', remote], cwd, GIT_BRANCH_REMOTE_TIMEOUT_MS)
    if (!fetched.success) return branchOperationFailure(fetched)
    return await getGitBranchesForCwd(cwd)
}

/**
 * Update only via a fast-forward pull. Dirty worktrees and branches without
 * an upstream are rejected before Git can modify checked-out files.
 */
export async function updateGitBranchForCwd(cwd: string): Promise<GitBranchesResponse> {
    const branches = await getGitBranchesForCwd(cwd)
    if (!branches.success) return branches
    if (!branches.currentBranch) {
        return {
            ...branches,
            success: false,
            code: 'detached_head',
            error: 'Cannot update while HEAD is detached'
        }
    }
    if (branches.isDirty) {
        return {
            ...branches,
            success: false,
            code: 'dirty_update_blocked',
            error: 'Commit or stash local changes before updating this branch'
        }
    }
    if (!branches.upstream) {
        return {
            ...branches,
            success: false,
            code: 'upstream_unavailable',
            error: 'The current branch does not have an upstream'
        }
    }

    const updated = await runGitCommand(['pull', '--ff-only'], cwd, GIT_BRANCH_REMOTE_TIMEOUT_MS)
    if (!updated.success) return branchOperationFailure(updated)
    return await getGitBranchesForCwd(cwd)
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
