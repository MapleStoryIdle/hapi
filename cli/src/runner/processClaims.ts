import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { configuration } from '@/configuration';
import { hasProcessIdentity, isProcessAlive, type ProcessIdentity } from '@/utils/process';

const MAX_CLAIM_BYTES = 64 * 1024;
const claimFilePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const claimMutationQueues = new Map<string, Promise<void>>();

const ProcessIdentitySchema = z.strictObject({
    pid: z.number().int().min(2),
    ppid: z.number().int().nonnegative(),
    platform: z.enum(['linux', 'darwin']),
    startToken: z.string().min(1).max(128)
});

const RunnerProcessClaimSchema = z.strictObject({
    schemaVersion: z.literal(1),
    launchId: z.string().uuid(),
    machineId: z.string().min(1).max(512),
    hapiHome: z.string().min(1).max(4096),
    pid: z.number().int().min(2),
    identity: ProcessIdentitySchema,
    sessionId: z.string().min(1).max(512).nullable(),
    state: z.enum(['awaiting-webhook', 'running', 'stopping']),
    spawnedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
});

export type RunnerProcessClaim = z.infer<typeof RunnerProcessClaimSchema>;
export type RunnerProcessClaimInspection = {
    claim: RunnerProcessClaim;
    status: 'verified-live' | 'dead' | 'identity-mismatch';
};

function claimsDirectory(): string {
    return join(configuration.happyHomeDir, 'runner-processes');
}

function claimPath(launchId: string): string {
    return join(claimsDirectory(), `${launchId}.json`);
}

async function ensureClaimsDirectory(): Promise<string> {
    const directory = claimsDirectory();
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
    });
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Runner process claims path is not a private directory');
    }
    await chmod(directory, 0o700).catch(() => {});
    return directory;
}

function enqueueClaimMutation(launchId: string, mutation: () => Promise<void>): Promise<void> {
    const previous = claimMutationQueues.get(launchId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(mutation);
    claimMutationQueues.set(launchId, current);
    void current.finally(() => {
        if (claimMutationQueues.get(launchId) === current) claimMutationQueues.delete(launchId);
    }).catch(() => {});
    return current;
}

export function writeRunnerProcessClaim(claim: RunnerProcessClaim): Promise<void> {
    const parsed = RunnerProcessClaimSchema.parse(claim);
    return enqueueClaimMutation(parsed.launchId, async () => {
        const directory = await ensureClaimsDirectory();
        const target = claimPath(parsed.launchId);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, target);
    });
}

/** Spawn bookkeeping must be durable before the event loop can accept a webhook. */
export function writeRunnerProcessClaimSync(claim: RunnerProcessClaim): void {
    const parsed = RunnerProcessClaimSchema.parse(claim);
    const directory = claimsDirectory();
    try {
        mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error('Runner process claims path is not a private directory');
    }
    try {
        chmodSync(directory, 0o700);
    } catch {
        // Best effort on platforms without POSIX permissions.
    }
    const target = claimPath(parsed.launchId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
        writeFileSync(fd, `${JSON.stringify(parsed, null, 2)}\n`);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, target);
}

export function removeRunnerProcessClaim(launchId: string): Promise<void> {
    if (!z.string().uuid().safeParse(launchId).success) return Promise.resolve();
    return enqueueClaimMutation(launchId, async () => {
        await unlink(claimPath(launchId)).catch(() => {});
    });
}

async function readClaimFile(path: string): Promise<RunnerProcessClaim | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stats = await handle.stat();
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_CLAIM_BYTES) return null;
        const parsed = RunnerProcessClaimSchema.safeParse(JSON.parse(await handle.readFile('utf8')));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    } finally {
        await handle?.close().catch(() => {});
    }
}

export async function listRunnerProcessClaims(): Promise<RunnerProcessClaim[]> {
    const directory = claimsDirectory();
    let names: string[];
    try {
        const stats = await lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) return [];
        names = await readdir(directory);
    } catch {
        return [];
    }

    const claims: RunnerProcessClaim[] = [];
    for (const name of names.slice(0, 1000)) {
        if (!claimFilePattern.test(name)) continue;
        const claim = await readClaimFile(join(directory, name));
        if (claim && `${claim.launchId}.json`.toLowerCase() === name.toLowerCase()) claims.push(claim);
    }
    return claims;
}

export function inspectRunnerProcessClaim(claim: RunnerProcessClaim): RunnerProcessClaimInspection {
    if (!isProcessAlive(claim.pid)) return { claim, status: 'dead' };
    if (claim.identity.pid !== claim.pid || !hasProcessIdentity(claim.identity as ProcessIdentity)) {
        return { claim, status: 'identity-mismatch' };
    }
    return { claim, status: 'verified-live' };
}
