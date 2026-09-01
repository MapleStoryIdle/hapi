import { describe, expect, it } from 'vitest';
import { convertCodexEvent } from './codexEventConverter';

describe('convertCodexEvent', () => {
    it('extracts session_meta id', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { id: 'session-123' }
        });

        expect(result).toEqual({ sessionId: 'session-123' });
    });

    it('converts agent_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'hello' }
        });

        expect(result?.message).toMatchObject({
            type: 'message',
            message: 'hello'
        });
    });

    it('converts user_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello user' }
        });

        expect(result?.userMessage).toBe('hello user');
    });

    it('unwraps generated user_message scaffolding', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'user_message',
                message: [
                    '# Files mentioned by the user:',
                    '## brief.txt: /private/generated/brief.txt',
                    '## My request:',
                    'Summarize the attachment.'
                ].join('\n')
            }
        });

        expect(result?.userMessage).toBe('Summarize the attachment.');
    });

    it('converts response_item user messages', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello from response_item user' }]
            }
        });

        expect(result).toEqual({
            userMessage: 'hello from response_item user'
        });
    });

    it('drops internal and legacy image parts from response_item user messages', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [
                    { type: 'input_text', text: '<environment_context>internal</environment_context>' },
                    { type: 'input_text', text: '<image name=[Image #1] path="/private/generated/image.png">' },
                    { type: 'input_image', image_url: 'data:image/png;base64,example' },
                    { type: 'input_text', text: '</image>' },
                    { type: 'input_text', text: 'Describe this image.' }
                ]
            }
        });

        expect(result).toEqual({ userMessage: 'Describe this image.' });
    });

    it('omits response_item messages that contain only internal context', () => {
        expect(convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '<goal_context>internal</goal_context>' }]
            }
        })).toBeNull();
    });

    it('converts response_item assistant messages', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello from response_item assistant' }]
            }
        });

        expect(result?.message).toMatchObject({
            type: 'message',
            message: 'hello from response_item assistant'
        });
    });

    it('does not filter assistant discussion of a scaffold marker', () => {
        const assistantText = 'The marker # Files mentioned by the user: came from generated context.';
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: assistantText }]
            }
        });

        expect(result?.message).toMatchObject({ type: 'message', message: assistantText });
    });

    it('converts reasoning events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text: 'thinking' }
        });

        expect(result?.message).toMatchObject({
            type: 'reasoning',
            message: 'thinking'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step' }
        });

        expect(result?.message).toEqual({
            type: 'reasoning-delta',
            delta: 'step'
        });
    });

    it('converts function_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ToolName',
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call',
            name: 'ToolName',
            callId: 'call-1',
            input: { foo: 'bar' }
        });
    });

    it('converts function_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call-2',
                output: { ok: true }
            }
        });

        expect(result?.message).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });
});
