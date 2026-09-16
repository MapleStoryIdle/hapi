import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return state.home;
        }
    }
}));

import { inspectRunnerProcessClaim, listRunnerProcessClaims, removeRunnerProcessClaim, writeRunnerProcessClaim, writeRunnerProcessClaimSync } from './processClaims';
import { readProcessIdentity } from '@/utils/process';

describe('runner process claims', () => {
    beforeEach(async () => {
        state.home = await mkdtemp(join(tmpdir(), 'hapi-process-claims-'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.runIf(process.platform === 'linux' || process.platform === 'darwin')('round-trips and verifies a live owned process identity', async () => {
        const identity = readProcessIdentity(process.pid);
        expect(identity).not.toBeNull();
        const claim = {
            schemaVersion: 1 as const,
            launchId: crypto.randomUUID(),
            machineId: 'machine-1',
            hapiHome: state.home,
            pid: process.pid,
            identity: identity!,
            sessionId: 'session-1',
            state: 'running' as const,
            spawnedAt: Date.now(),
            updatedAt: Date.now()
        };

        writeRunnerProcessClaimSync(claim);
        const updated = { ...claim, sessionId: 'session-updated', state: 'running' as const, updatedAt: claim.updatedAt + 1 };
        await writeRunnerProcessClaim(updated);
        const listed = await listRunnerProcessClaims();
        expect(listed).toEqual([updated]);
        expect(inspectRunnerProcessClaim(listed[0]).status).toBe('verified-live');

        await removeRunnerProcessClaim(claim.launchId);
        expect(await listRunnerProcessClaims()).toEqual([]);
    });

    it('rejects malformed, oversized and symlink claim files', async () => {
        const directory = join(state.home, 'runner-processes');
        await mkdir(directory, { recursive: true });
        const malformed = `${crypto.randomUUID()}.json`;
        await writeFile(join(directory, malformed), '{"pid":1}');
        const oversized = `${crypto.randomUUID()}.json`;
        await writeFile(join(directory, oversized), 'x'.repeat(64 * 1024 + 1));
        const target = join(state.home, 'outside.json');
        await writeFile(target, JSON.stringify({}));
        const linked = `${crypto.randomUUID()}.json`;
        await symlink(target, join(directory, linked));

        expect(await listRunnerProcessClaims()).toEqual([]);
        expect(await readFile(target, 'utf8')).toBe('{}');
    });

    it('refuses a symlinked claims directory', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-process-claims-outside-'));
        await symlink(outside, join(state.home, 'runner-processes'));
        const identity = readProcessIdentity(process.pid);
        if (!identity) return;
        await expect(writeRunnerProcessClaim({
            schemaVersion: 1,
            launchId: crypto.randomUUID(),
            machineId: 'machine-1',
            hapiHome: state.home,
            pid: process.pid,
            identity,
            sessionId: null,
            state: 'awaiting-webhook',
            spawnedAt: Date.now(),
            updatedAt: Date.now()
        })).rejects.toThrow('not a private directory');
        expect(await readdir(outside)).toEqual([]);
    });
});
