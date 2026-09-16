import { beforeEach, describe, expect, it, vi } from 'vitest';

const killRunawayHappyProcessesMock = vi.hoisted(() => vi.fn());
const previewRunawayHappyProcessesMock = vi.hoisted(() => vi.fn());
const runDoctorCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@/runner/doctor', () => ({
    killRunawayHappyProcesses: killRunawayHappyProcessesMock,
    previewRunawayHappyProcesses: previewRunawayHappyProcessesMock
}));
vi.mock('@/ui/doctor', () => ({
    runDoctorCommand: runDoctorCommandMock
}));

import { doctorCommand } from './doctor';

describe('doctor clean', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        killRunawayHappyProcessesMock.mockResolvedValue({
            killed: 0,
            errors: [],
            skipped: [{ pid: 321, command: 'shapi runner start-sync', reason: 'unmanaged-process-discovery' }]
        });
        previewRunawayHappyProcessesMock.mockResolvedValue([
            { pid: 321, command: 'shapi runner start-sync', reason: 'unmanaged-process-discovery' }
        ]);
    });

    it('reports a dry run instead of stopping discovered processes', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);

        try {
            await expect(doctorCommand.run({ args: ['doctor', 'clean'], commandArgs: ['clean'] })).rejects.toThrow('exit:0');
            expect(logSpy).toHaveBeenCalledWith('Dry run only: 1 processes inspected; none stopped.');
            expect(logSpy).toHaveBeenCalledWith('Would not stop PID 321: unmanaged-process-discovery');
        } finally {
            logSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });

    it('prints a read-only JSON process inventory', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);
        try {
            await expect(doctorCommand.run({ args: [], commandArgs: ['processes', '--json'] })).rejects.toThrow('exit:0');
            expect(logSpy).toHaveBeenCalledWith(JSON.stringify(await previewRunawayHappyProcessesMock(), null, 2));
        } finally {
            logSpy.mockRestore();
            exitSpy.mockRestore();
        }
    });
});
