import { describe, expect, it } from 'vitest';
import { createCodexUserMessageMirrorDeduper } from './codexUserMessageMirror';
import type { CodexSessionEvent } from './codexEventConverter';

function response(text: string, timestamp?: string): CodexSessionEvent {
    return {
        ...(timestamp ? { timestamp } : {}),
        type: 'response_item',
        payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }]
        }
    };
}

function event(text: string, timestamp?: string): CodexSessionEvent {
    return {
        ...(timestamp ? { timestamp } : {}),
        type: 'event_msg',
        payload: { type: 'user_message', message: text }
    };
}

describe('createCodexUserMessageMirrorDeduper', () => {
    it('suppresses one opposite-source mirror and keeps a later real repeat', () => {
        const deduper = createCodexUserMessageMirrorDeduper();

        expect(deduper.shouldSuppress(response('repeat', '2026-08-31T10:00:00.000Z'), 'repeat')).toBe(false);
        expect(deduper.shouldSuppress(event('repeat', '2026-08-31T10:00:00.007Z'), 'repeat')).toBe(true);
        expect(deduper.shouldSuppress(response('repeat', '2026-08-31T10:00:01.000Z'), 'repeat')).toBe(false);
        expect(deduper.shouldSuppress(event('repeat', '2026-08-31T10:00:01.005Z'), 'repeat')).toBe(true);
    });

    it('does not merge different raw attachment carriers with the same request', () => {
        const deduper = createCodexUserMessageMirrorDeduper();

        expect(deduper.shouldSuppress(response('attachment-a', '2026-08-31T10:00:00.000Z'), 'Describe it.')).toBe(false);
        expect(deduper.shouldSuppress(event('attachment-b', '2026-08-31T10:00:00.005Z'), 'Describe it.')).toBe(false);
    });

    it('only pairs adjacent untimestamped records', () => {
        const deduper = createCodexUserMessageMirrorDeduper();

        expect(deduper.shouldSuppress(response('prompt'), 'prompt')).toBe(false);
        expect(deduper.shouldSuppress(event('prompt'), 'prompt')).toBe(true);

        expect(deduper.shouldSuppress(response('later'), 'later')).toBe(false);
        deduper.shouldSuppress({ type: 'event_msg', payload: { type: 'task_started' } }, '');
        expect(deduper.shouldSuppress(event('later'), 'later')).toBe(false);
    });
});
