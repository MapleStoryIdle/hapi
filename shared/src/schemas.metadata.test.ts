import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './schemas';

describe('MetadataSchema cursorSessionProtocol', () => {
    const base = {
        path: '/tmp',
        host: 'test'
    };

    it('accepts acp and stream-json protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'acp' }).success).toBe(true);
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'stream-json' }).success).toBe(true);
    });

    it('rejects unknown protocol values', () => {
        expect(MetadataSchema.safeParse({ ...base, cursorSessionProtocol: 'websocket' }).success).toBe(false);
    });
});

describe('AgentStateSchema codex subagents', () => {
    /**
     * Codex child-agent state is session runtime state, so schema parsing must
     * preserve it instead of stripping it as an unknown agentState key.
     */
    it('preserves codex subagent snapshots', async () => {
        const { AgentStateSchema } = await import('./schemas')
        const parsed = AgentStateSchema.parse({
            controlledByUser: false,
            codex: {
                activeSubagentId: 'agent-1',
                updatedAt: 1_700_000_000_000,
                subagents: {
                    'agent-1': {
                        id: 'agent-1',
                        cardId: 'card-1',
                        threadId: 'thread-1',
                        turnId: 'turn-1',
                        type: 'general-purpose',
                        summary: 'inspect composer layout',
                        status: 'running',
                        activity: 'Reading files',
                        startedAt: 1_700_000_000_000,
                        updatedAt: 1_700_000_001_000
                    }
                }
            }
        })

        expect(parsed.codex?.activeSubagentId).toBe('agent-1')
        expect(parsed.codex?.subagents?.['agent-1']?.activity).toBe('Reading files')
    })
})
