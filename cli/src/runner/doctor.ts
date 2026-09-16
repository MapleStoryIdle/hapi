/**
 * Runner doctor process discovery.
 *
 * Process-list matches are diagnostic only. Legacy Runner state has no durable
 * process-identity proof, so Doctor never signals a discovered PID.
 */

import psList from 'ps-list';
import { inspectRunnerProcessClaim, listRunnerProcessClaims } from './processClaims';

export type DoctorProcess = { pid: number; command: string; type: string };
export type DoctorCleanupPreview = {
    pid: number;
    command: string;
    reason: 'verified-managed-live' | 'dead-stale-claim' | 'identity-mismatch' | 'unmanaged-process-discovery';
};

/** Find SHAPI-looking processes for display. This does not establish ownership. */
export async function findAllHappyProcesses(): Promise<DoctorProcess[]> {
    try {
        const processes = await psList();
        const allProcesses: DoctorProcess[] = [];

        for (const proc of processes) {
            const cmd = proc.cmd || '';
            const name = proc.name || '';
            const isHappyBinary = name === 'hapi'
                || name === 'hapi.exe'
                || name === 'shapi'
                || name === 'shapi.exe'
                || /\b(?:shapi|hapi)(?:\.exe)?\b/.test(cmd);
            const isDevMode = cmd.includes('src/index.ts');
            const isHappy = name.includes('happy')
                || name === 'node' && cmd.includes('happy-cli')
                || cmd.includes('happy-coder')
                || isHappyBinary
                || isDevMode;

            if (!isHappy) continue;

            let type = 'unknown';
            if (proc.pid === process.pid) {
                type = 'current';
            } else if (cmd.includes('--version')) {
                type = isDevMode ? 'dev-runner-version-check' : 'runner-version-check';
            } else if (cmd.includes('runner start-sync') || cmd.includes('runner start')) {
                type = isDevMode ? 'dev-runner' : 'runner';
            } else if (cmd.includes('--started-by runner')) {
                type = isDevMode ? 'dev-runner-spawned' : 'runner-spawned-session';
            } else if (cmd.includes('doctor')) {
                type = isDevMode ? 'dev-doctor' : 'doctor';
            } else if (cmd.includes('--yolo')) {
                type = 'dev-session';
            } else {
                type = isDevMode ? 'dev-related' : 'user-session';
            }

            allProcesses.push({ pid: proc.pid, command: cmd || name, type });
        }

        return allProcesses;
    } catch {
        return [];
    }
}

/** Discovery candidates only; command text is never kill authorization. */
export async function findRunawayHappyProcesses(): Promise<Array<{ pid: number; command: string }>> {
    const allProcesses = await findAllHappyProcesses();
    return allProcesses
        .filter(p => p.pid !== process.pid && (
            p.type === 'runner'
            || p.type === 'dev-runner'
            || p.type === 'runner-spawned-session'
            || p.type === 'dev-runner-spawned'
            || p.type === 'runner-version-check'
            || p.type === 'dev-runner-version-check'
        ))
        .map(p => ({ pid: p.pid, command: p.command }));
}

export async function previewRunawayHappyProcesses(): Promise<DoctorCleanupPreview[]> {
    const claims = await listRunnerProcessClaims();
    const claimedPids = new Set(claims.map(claim => claim.pid));
    const managed = claims.map(claim => {
        const inspection = inspectRunnerProcessClaim(claim);
        const reason = inspection.status === 'verified-live'
            ? 'verified-managed-live' as const
            : inspection.status === 'dead'
                ? 'dead-stale-claim' as const
                : 'identity-mismatch' as const;
        return {
            pid: claim.pid,
            command: `managed session ${claim.sessionId ?? '(awaiting webhook)'} launch ${claim.launchId}`,
            reason
        };
    });
    const discovered = (await findRunawayHappyProcesses())
        .filter(process => !claimedPids.has(process.pid))
        .map(({ pid, command }) => ({
            pid,
            command,
            reason: 'unmanaged-process-discovery' as const
        }));
    return [...managed, ...discovered];
}

/**
 * Compatibility-shaped result for callers. This is permanently dry-run until
 * an explicit managed-process ownership record and confirmation flow exist.
 */
export async function killRunawayHappyProcesses(): Promise<{
    killed: number;
    errors: Array<{ pid: number; error: string }>;
    skipped: DoctorCleanupPreview[];
}> {
    return { killed: 0, errors: [], skipped: await previewRunawayHappyProcesses() };
}
