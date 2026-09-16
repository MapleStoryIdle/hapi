import { spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const isWindows = (): boolean => process.platform === 'win32';

export function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export type ProcessIdentity = {
    readonly pid: number;
    readonly ppid: number;
    readonly platform: 'linux' | 'darwin';
    readonly startToken: string;
};

function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
    try {
        // comm (field 2) may contain spaces or ')'. Remaining fields start at 3.
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const closingParen = stat.lastIndexOf(')');
        if (closingParen < 0) return null;
        const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
        const ppid = Number(fields[1]);
        const startToken = fields[19];
        if (!Number.isSafeInteger(ppid) || ppid < 0 || !startToken || !/^\d+$/.test(startToken)) return null;
        return { pid, ppid, platform: 'linux', startToken };
    } catch {
        return null;
    }
}

function readDarwinProcessIdentity(pid: number): ProcessIdentity | null {
    try {
        const result = spawnSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'lstart='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        if (result.error || result.status !== 0) return null;
        const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) return null;
        const ppid = Number(match[1]);
        const startedAt = Date.parse(match[2]);
        if (!Number.isSafeInteger(ppid) || ppid < 0 || !Number.isFinite(startedAt)) return null;
        return { pid, ppid, platform: 'darwin', startToken: String(startedAt) };
    } catch {
        return null;
    }
}

export function readProcessIdentity(pid: number): ProcessIdentity | null {
    if (!isProcessAlive(pid)) return null;
    if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
    if (process.platform === 'darwin') return readDarwinProcessIdentity(pid);
    return null;
}

export function hasProcessIdentity(identity: ProcessIdentity): boolean {
    const observed = readProcessIdentity(identity.pid);
    return observed !== null
        && observed.platform === identity.platform
        && observed.startToken === identity.startToken;
}

function hasProcessTreeIdentity(identity: ProcessIdentity): boolean {
    const observed = readProcessIdentity(identity.pid);
    return observed !== null
        && observed.platform === identity.platform
        && observed.ppid === identity.ppid
        && observed.startToken === identity.startToken;
}

export function isHapiRunnerCommand(commandLine: string): boolean {
    const isPackagedRunner = /(?:^|[\\/])(?:s?hapi)(?:\.exe)?(?:"|\s|$)/i.test(commandLine);
    const isSourceRunner = /[\\/]cli[\\/]src[\\/]index\.ts(?:"|\s|$)/i.test(commandLine);
    return /(?:^|\s)runner(?:\s|$)/.test(commandLine)
        && /(?:^|\s)start-sync(?:\s|$)/.test(commandLine)
        && (isPackagedRunner || isSourceRunner);
}

export function isHapiRunnerProcess(pid: number): boolean {
    if (!isProcessAlive(pid)) return false;
    try {
        if (isWindows()) {
            const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`;
            const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']
            });
            return !result.error && result.status === 0 && isHapiRunnerCommand(result.stdout ?? '');
        }
        const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
        });
        return !result.error && result.status === 0 && isHapiRunnerCommand(result.stdout ?? '');
    } catch {
        return false;
    }
}

/** Bare PIDs do not carry ownership proof and are never signalled. */
export async function killProcess(_pid: number, _force: boolean = false): Promise<boolean> {
    return false;
}

async function waitForIdentityToDisappear(identity: ProcessIdentity, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && hasProcessIdentity(identity)) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

/**
 * Signals only the live ChildProcess handle created by this process. It never
 * walks descendant PIDs; that avoids check-then-signal PID reuse races.
 */
export async function terminateOwnedChildProcess(child: ChildProcess, force: boolean = false): Promise<boolean> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return false;

    const root = readProcessIdentity(pid);
    if (!root) {
        // A live ChildProcess handle proves direct ownership. On unsupported
        // platforms, signal only that handle; never walk or kill a PID tree.
        if (!isWindows() || child.exitCode !== null || child.signalCode !== null) return false;
        // Node retains the direct child handle on Windows. Use that handle;
        // `taskkill /PID /T` would reintroduce PID-reuse risk for descendants.
        return child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }

    if (root.ppid !== process.pid || !hasProcessTreeIdentity(root)) return false;
    const signalled = child.kill(force ? 'SIGKILL' : 'SIGTERM');

    if (!force && signalled) {
        await waitForIdentityToDisappear(root, 2000);
        if (hasProcessTreeIdentity(root)) {
            child.kill('SIGKILL');
            await waitForIdentityToDisappear(root, 1000);
        }
    }
    return signalled || !hasProcessIdentity(root);
}

function readProcessGroupId(pid: number): number | null {
    if (isWindows()) return null;
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'pgid='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    });
    if (result.error || result.status !== 0) return null;
    const pgid = Number(result.stdout.trim());
    return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null;
}

function isProcessGroupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Terminates a detached child process group created by the Runner. The group
 * is eligible only while its verified root is still the group leader. A
 * single process-group signal avoids enumerating descendant PIDs.
 */
export async function terminateOwnedDetachedProcessGroup(child: ChildProcess, force: boolean = false): Promise<boolean> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return false;
    if (isWindows()) return terminateOwnedChildProcess(child, force);

    const identity = readProcessIdentity(pid);
    if (!identity || identity.ppid !== process.pid || !hasProcessTreeIdentity(identity) || readProcessGroupId(pid) !== pid) return false;
    try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
        return !hasProcessIdentity(identity);
    }
    if (!force) {
        await waitForIdentityToDisappear(identity, 2000);
        const sameRootStillLeads = hasProcessTreeIdentity(identity) && readProcessGroupId(pid) === pid;
        // A detached child created a new POSIX session. If its leader exited
        // but the group still exists, remaining members can only belong to
        // that session. Refuse escalation if the leader PID was reused.
        const leaderExitedWithOwnedGroupRemaining = !isProcessAlive(pid) && isProcessGroupAlive(pid);
        if (sameRootStillLeads || leaderExitedWithOwnedGroupRemaining) {
            try {
                process.kill(-pid, 'SIGKILL');
            } catch {
                // It may have exited after verification.
            }
            await waitForIdentityToDisappear(identity, 1000);
        }
    }
    return true;
}

/** @deprecated Use terminateOwnedChildProcess. Retained as a safe alias. */
export async function killProcessByChildProcess(child: ChildProcess, force: boolean = false): Promise<boolean> {
    if (!isWindows() && child.pid && readProcessGroupId(child.pid) === child.pid) {
        return terminateOwnedDetachedProcessGroup(child, force);
    }
    return terminateOwnedChildProcess(child, force);
}
