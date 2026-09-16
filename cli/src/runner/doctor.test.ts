import { beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.hoisted(() => vi.fn());
vi.mock('ps-list', () => ({ default: psListMock }));

import { findRunawayHappyProcesses, killRunawayHappyProcesses, previewRunawayHappyProcesses } from './doctor';

describe('runner doctor process cleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        psListMock.mockResolvedValue([
            { pid: 321, name: 'shapi', cmd: 'shapi runner start-sync' },
            { pid: 322, name: 'node', cmd: 'node unrelated-service.js' }
        ]);
    });

    it('uses command matches only for discovery', async () => {
        await expect(findRunawayHappyProcesses()).resolves.toEqual([
            { pid: 321, command: 'shapi runner start-sync' }
        ]);
    });

    it('defaults cleanup to dry-run and never signals unmanaged discoveries', async () => {
        await expect(previewRunawayHappyProcesses()).resolves.toEqual([
            {
                pid: 321,
                command: 'shapi runner start-sync',
                reason: 'unmanaged-process-discovery'
            }
        ]);
        await expect(killRunawayHappyProcesses()).resolves.toEqual({
            killed: 0,
            errors: [],
            skipped: [{
                pid: 321,
                command: 'shapi runner start-sync',
                reason: 'unmanaged-process-discovery'
            }]
        });
    });
});
