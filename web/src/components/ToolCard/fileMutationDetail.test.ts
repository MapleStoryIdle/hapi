import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { getFileMutationDialogSummary } from '@/components/ToolCard/fileMutationDetail'

function makeBlock(name: string, input: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: `tool:${name}`,
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            id: `tool:${name}`,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: null
        }
    }
}

describe('file mutation dialog summary', () => {
    it('uses the basename and exact Edit line counts', () => {
        const summary = getFileMutationDialogSummary(makeBlock('Edit', {
            file_path: '/workspace/web/src/App.tsx',
            old_string: 'old value\n',
            new_string: 'new value\nanother line\n'
        }), null)

        expect(summary).toEqual({
            fileNames: ['App.tsx'],
            title: 'App.tsx',
            additions: 2,
            deletions: 1
        })
    })

    it('totals a multi-file Codex patch without exposing directories', () => {
        const summary = getFileMutationDialogSummary(makeBlock('CodexPatch', {
            changes: [{
                path: '/workspace/web/src/App.tsx',
                diff: '@@ -1 +1,2 @@\n-old\n+new\n+extra\n'
            }, {
                path: '/workspace/hub/src/index.ts',
                diff: '@@ -2 +2 @@\n-before\n+after\n'
            }]
        }), null)

        expect(summary).toEqual({
            fileNames: ['App.tsx', 'index.ts'],
            title: 'App.tsx +1',
            additions: 3,
            deletions: 2
        })
    })
})
