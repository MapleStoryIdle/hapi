import { describe, expect, it } from 'vitest';
import { configureNonInteractiveTerminalColors } from './terminalColorEnv';

describe('configureNonInteractiveTerminalColors', () => {
    it('forces color while preserving a capable terminal declaration', () => {
        const env: NodeJS.ProcessEnv = { TERM: 'screen-256color', COLORTERM: '24bit', NO_COLOR: '1' };

        configureNonInteractiveTerminalColors(env);

        expect(env).toMatchObject({
            TERM: 'screen-256color',
            COLORTERM: '24bit',
            FORCE_COLOR: '1',
            CLICOLOR_FORCE: '1'
        });
        expect(env.NO_COLOR).toBeUndefined();
    });

    it('replaces a non-color terminal with true-color defaults', () => {
        const env: NodeJS.ProcessEnv = { TERM: 'dumb' };

        configureNonInteractiveTerminalColors(env);

        expect(env.TERM).toBe('xterm-256color');
        expect(env.COLORTERM).toBe('truecolor');
    });
});
