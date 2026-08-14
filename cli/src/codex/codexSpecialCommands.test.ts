import { describe, expect, it } from 'vitest';
import { parseCodexSpecialCommand } from './codexSpecialCommands';

describe('parseCodexSpecialCommand', () => {
    it('accepts exact /clear and /compact commands', () => {
        expect(parseCodexSpecialCommand('  /clear  ')).toEqual({ type: 'clear' });
        expect(parseCodexSpecialCommand('/compact')).toEqual({ type: 'compact' });
    });

    it('accepts /review targets', () => {
        expect(parseCodexSpecialCommand('/review')).toEqual({
            type: 'review',
            target: { type: 'uncommittedChanges' }
        });
        expect(parseCodexSpecialCommand('/review --uncommitted')).toEqual({
            type: 'review',
            target: { type: 'uncommittedChanges' }
        });
        expect(parseCodexSpecialCommand('/review --base main')).toEqual({
            type: 'review',
            target: { type: 'baseBranch', branch: 'main' }
        });
        expect(parseCodexSpecialCommand('/review --commit abc123 --title "Fix login"')).toEqual({
            type: 'review',
            target: { type: 'commit', sha: 'abc123', title: 'Fix login' }
        });
        expect(parseCodexSpecialCommand('/review focus on security regressions')).toEqual({
            type: 'review',
            target: { type: 'custom', instructions: 'focus on security regressions' }
        });
    });

    it('rejects argument-bearing special commands without treating them as prompts', () => {
        expect(parseCodexSpecialCommand('/clear now')).toEqual({
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        });
        expect(parseCodexSpecialCommand('/compact summarize this')).toEqual({
            type: 'invalid',
            command: 'compact',
            message: '/compact does not accept arguments'
        });
        expect(parseCodexSpecialCommand('/review --base')).toEqual({
            type: 'invalid',
            command: 'review',
            message: 'Usage: /review [--uncommitted|--base <branch>|--commit <sha> [--title <title>]|instructions]'
        });
        expect(parseCodexSpecialCommand('/review --uncommitted --title nope')).toEqual({
            type: 'invalid',
            command: 'review',
            message: '--title can only be used with --commit'
        });
    });

    it('ignores regular slash-like messages', () => {
        expect(parseCodexSpecialCommand('/clearing')).toEqual({ type: null });
        expect(parseCodexSpecialCommand('please /clear')).toEqual({ type: null });
    });
});
