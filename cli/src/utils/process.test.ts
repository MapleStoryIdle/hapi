import { describe, expect, it } from 'vitest';
import { hasProcessIdentity, isHapiRunnerCommand, killProcess, readProcessIdentity } from './process';

describe('process safety', () => {
    it('refuses arbitrary PID termination', async () => {
        await expect(killProcess(process.pid, true)).resolves.toBe(false);
    });

    it('recognizes packaged and source runners without matching unrelated commands', () => {
        expect(isHapiRunnerCommand('"C:\\Program Files\\SHAPI\\shapi.exe" runner start-sync')).toBe(true);
        expect(isHapiRunnerCommand('/usr/local/bin/hapi runner start-sync')).toBe(true);
        expect(isHapiRunnerCommand('bun /repo/cli/src/index.ts runner start-sync')).toBe(true);
        expect(isHapiRunnerCommand('node unrelated.js runner start-sync')).toBe(false);
    });

    it.runIf(process.platform === 'linux')('uses Linux process start ticks as PID identity', () => {
        const identity = readProcessIdentity(process.pid);
        expect(identity).not.toBeNull();
        expect(hasProcessIdentity(identity!)).toBe(true);
    });

    it.runIf(process.platform === 'darwin')('uses macOS process birth time and parent as PID identity', () => {
        const identity = readProcessIdentity(process.pid);
        expect(identity).not.toBeNull();
        expect(identity?.platform).toBe('darwin');
        expect(hasProcessIdentity(identity!)).toBe(true);
        expect(hasProcessIdentity({ ...identity!, ppid: identity!.ppid + 1 })).toBe(true);
    });

    it.runIf(process.platform !== 'linux' && process.platform !== 'darwin')('fails closed when no robust platform identity is available', () => {
        expect(readProcessIdentity(process.pid)).toBeNull();
    });
});
