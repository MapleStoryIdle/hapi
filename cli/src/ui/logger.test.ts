import { describe, expect, it } from 'vitest';
import { serializeLogValue } from './logger';

describe('serializeLogValue', () => {
    it('preserves Error details and nested causes instead of writing empty objects', () => {
        const cause = new Error('socket closed');
        const error = new Error('Codex app-server exited', { cause });

        expect(serializeLogValue(error)).toMatchObject({
            name: 'Error',
            message: 'Codex app-server exited',
            stack: expect.stringContaining('Codex app-server exited'),
            cause: {
                name: 'Error',
                message: 'socket closed',
                stack: expect.stringContaining('socket closed')
            }
        });
    });

    it('serializes errors nested inside ordinary log metadata', () => {
        expect(serializeLogValue({ operation: 'turn/start', error: new TypeError('bad response') })).toMatchObject({
            operation: 'turn/start',
            error: {
                name: 'TypeError',
                message: 'bad response'
            }
        });
    });
});
