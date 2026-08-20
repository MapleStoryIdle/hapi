import { describe, expect, it } from 'vitest'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import {
    buildVisibleChatBlocks,
    filterCodexDiffsCoveredByPatches,
    getToolGroupActionKind,
    isEligibleForToolGrouping,
    isToolGroupBlock
} from '@/chat/toolGroups'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown = {},
    overrides: Partial<ToolCallBlock> = {}
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        invokedAt: null,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: null,
            permission: undefined,
        },
        children: [],
        ...overrides,
    }
}

function makeTextBlock(id: string, text = 'note'): ChatBlock {
    return {
        kind: 'agent-text',
        id,
        localId: null,
        createdAt: 1,
        text,
    }
}

describe('getToolGroupActionKind', () => {
    it('classifies common execution tools', () => {
        expect(getToolGroupActionKind(makeToolBlock('read-1', 'Read'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('read-file-1', 'read_file'))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('grep-1', 'Grep'))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('bash-1', 'Bash'))).toBe('command')
        expect(getToolGroupActionKind(makeToolBlock('edit-1', 'Edit'))).toBe('mutation')
    })

    it('classifies read-only shell commands by their intent', () => {
        expect(getToolGroupActionKind(makeToolBlock('rg-1', 'Bash', { command: 'rg "TODO" web/src' }))).toBe('search')
        expect(getToolGroupActionKind(makeToolBlock('ls-1', 'Bash', { command: 'ls web/src' }))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('diff-1', 'Bash', { command: 'git diff -- web/src/router.tsx' }))).toBe('read')
        expect(getToolGroupActionKind(makeToolBlock('patch-1', 'Bash', { command: 'apply_patch <<PATCH' }))).toBe('mutation')
        expect(getToolGroupActionKind(makeToolBlock('test-1', 'Bash', { command: 'bun test' }))).toBe('command')
    })

    it('does not present Codex parsed commands as actual reads', () => {
        expect(getToolGroupActionKind(makeToolBlock('codex-read-1', 'CodexBash', {
            command: 'pwd; cat src/App.tsx',
            parsed_cmd: [{ type: 'read', name: 'src/App.tsx' }]
        }))).toBe('command')
    })
})

describe('isEligibleForToolGrouping', () => {
    it('groups every noninteractive tool card', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('read-1', 'Read'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('codex-read-1', 'CodexBash', {
            command: "sed -n '12,80p' src/App.tsx"
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('codex-sequential-read-1', 'CodexBash', {
            command: "cat AGENT.md && sed -n '12,80p' src/App.tsx"
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('codex-sequential-read-with-pipeline-1', 'CodexBash', {
            command: "cat AGENT.md; find src -type f | sort; sed -n '12,80p' src/App.tsx"
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('mcp-read-1', 'mcp__files__read', {
            path: 'src/App.tsx', startLine: 12, endLine: 80
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('patch-1', 'CodexPatch', {
            changes: [{ path: 'src/App.tsx', diff: '@@ -1 +1 @@\n-old\n+new' }]
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('diff-1', 'CodexDiff', {
            unified_diff: '--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new'
        }))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('task-1', 'Task'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('plan-1', 'update_plan'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('ask-1', 'AskUserQuestion'))).toBe(true)
        expect(isEligibleForToolGrouping(makeToolBlock('perm-1', 'Bash', {}, {
            tool: {
                id: 'perm-1',
                name: 'Bash',
                state: 'pending',
                input: {},
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                description: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        }))).toBe(false)
    })

    it('keeps completed permissioned execution cards eligible for grouping', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('approved-1', 'Bash', {}, {
            tool: {
                id: 'approved-1',
                name: 'Bash',
                state: 'completed',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'approved-1',
                    status: 'approved'
                }
            }
        }))).toBe(true)

        expect(isEligibleForToolGrouping(makeToolBlock('denied-1', 'Edit', {}, {
            tool: {
                id: 'denied-1',
                name: 'Edit',
                state: 'error',
                input: {},
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'denied-1',
                    status: 'denied',
                    reason: 'blocked'
                }
            }
        }))).toBe(true)
    })

    it('folds completed Codex permission milestones', () => {
        expect(isEligibleForToolGrouping(makeToolBlock('codex-perm-1', 'CodexPermission', {}, {
            tool: {
                id: 'codex-perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                permission: {
                    id: 'codex-perm-1',
                    status: 'approved'
                }
            }
        }))).toBe(true)
    })

    it('folds titled MCP calls while retaining their title in the compact row', () => {
        expect(isEligibleForToolGrouping(makeToolBlock(
            'mcp-titled-1',
            'mcp__node_repl__js',
            { title: '查看本地会话', code: 'nodeRepl.write("ok")' }
        ))).toBe(true)

        expect(isEligibleForToolGrouping(makeToolBlock(
            'mcp-untitled-1',
            'mcp__node_repl__js',
            { code: 'nodeRepl.write("ok")' }
        ))).toBe(true)
    })
})

describe('buildVisibleChatBlocks', () => {
    it('renders an answered question as a user choice instead of an assistant tool card', () => {
        const question = makeToolBlock('question-1', 'request_user_input', {
            questions: [{
                id: 'direction',
                question: 'Which direction?',
                options: [{ label: 'Keep it compact' }]
            }]
        })
        question.tool.permission = {
            id: 'question-1',
            status: 'approved',
            completedAt: 5,
            answers: { direction: { answers: ['Keep it compact'] } }
        }

        const visible = buildVisibleChatBlocks([question], {
            hasMoreMessages: false,
            terminalToolDisplayMode: 'compact'
        })

        expect(visible).toEqual([expect.objectContaining({
            kind: 'question-answer',
            id: 'question-1',
            createdAt: 5,
            answer: {
                items: [{
                    question: 'Which direction?',
                    answers: ['Keep it compact'],
                    options: [{ label: 'Keep it compact', description: null, selected: true }]
                }]
            }
        })])
    })

    it('folds an explicit skill load into a compact activity row', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('intro', '使用 `imagegen`：生成预览图。'),
            makeToolBlock('read-skill', 'CodexBash', {
                command: "/bin/zsh -lc 'cat /Users/dev/.codex/skills/.system/imagegen/SKILL.md'"
            })
        ], {
            hasMoreMessages: false,
            terminalToolDisplayMode: 'compact'
        })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected compact tool group')
        }
        expect(visible[0].tools[0]).toMatchObject({
            tool: { name: 'Skill', input: { skill: 'imagegen' } }
        })
        expect(visible[0].forceCompact).toBe(true)
    })

    it('uses CodexPatch as the authoritative view for a matching diff in the same user turn', () => {
        const visible = filterCodexDiffsCoveredByPatches([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: null,
                createdAt: 1,
                text: 'update the app'
            },
            makeToolBlock('patch-1', 'CodexPatch', {
                changes: [{ path: '/workspace/hapi/web/src/App.tsx', diff: '@@ -1 +1 @@\n-old\n+new' }]
            }),
            makeToolBlock('diff-1', 'CodexDiff', {
                unified_diff: 'diff --git a/web/src/App.tsx b/web/src/App.tsx\n--- a/web/src/App.tsx\n+++ b/web/src/App.tsx\n@@ -1 +1 @@\n-old\n+new'
            })
        ])

        expect(visible.map((block) => block.id)).toEqual(['user-1', 'patch-1'])
    })

    it('keeps CodexDiff when no patch covers every changed file in the turn', () => {
        const blocks: ChatBlock[] = [
            {
                kind: 'user-text',
                id: 'user-1',
                localId: null,
                createdAt: 1,
                text: 'update the app'
            },
            makeToolBlock('patch-1', 'CodexPatch', {
                changes: [{ path: '/workspace/hapi/web/src/App.tsx', diff: '@@ -1 +1 @@\n-old\n+new' }]
            }),
            makeToolBlock('diff-1', 'CodexDiff', {
                unified_diff: [
                    'diff --git a/web/src/App.tsx b/web/src/App.tsx',
                    '--- a/web/src/App.tsx',
                    '+++ b/web/src/App.tsx',
                    'diff --git a/web/src/fallback.ts b/web/src/fallback.ts',
                    '--- a/web/src/fallback.ts',
                    '+++ b/web/src/fallback.ts'
                ].join('\n')
            })
        ]

        expect(filterCodexDiffsCoveredByPatches(blocks).map((block) => block.id)).toEqual([
            'user-1',
            'patch-1',
            'diff-1'
        ])
    })

    it('does not let a prior user turn suppress a diff-only fallback', () => {
        const visible = filterCodexDiffsCoveredByPatches([
            {
                kind: 'user-text',
                id: 'user-1',
                localId: null,
                createdAt: 1,
                text: 'first turn'
            },
            makeToolBlock('patch-1', 'CodexPatch', {
                changes: [{ path: '/workspace/hapi/web/src/App.tsx' }]
            }),
            {
                kind: 'user-text',
                id: 'user-2',
                localId: null,
                createdAt: 2,
                text: 'second turn'
            },
            makeToolBlock('diff-1', 'CodexDiff', {
                unified_diff: 'diff --git a/web/src/App.tsx b/web/src/App.tsx\n--- a/web/src/App.tsx\n+++ b/web/src/App.tsx'
            })
        ])

        expect(visible.map((block) => block.id)).toEqual(['user-1', 'patch-1', 'user-2', 'diff-1'])
    })

    it('treats an answered question as a user-turn boundary for patch fallback', () => {
        const answeredQuestion = makeToolBlock('question-1', 'request_user_input', {
            questions: [{ id: 'confirm', question: 'Continue?', options: [{ label: 'Continue' }] }]
        })
        answeredQuestion.tool.permission = {
            id: 'question-1',
            status: 'approved',
            answers: { confirm: { answers: ['Continue'] } }
        }
        const visible = filterCodexDiffsCoveredByPatches([
            makeToolBlock('patch-1', 'CodexPatch', {
                changes: [{ path: '/workspace/hapi/web/src/App.tsx' }]
            }),
            answeredQuestion,
            makeToolBlock('diff-1', 'CodexDiff', {
                unified_diff: 'diff --git a/web/src/App.tsx b/web/src/App.tsx\n--- a/web/src/App.tsx\n+++ b/web/src/App.tsx'
            })
        ])

        expect(visible.map((block) => block.id)).toEqual(['patch-1', 'question-1', 'diff-1'])
    })

    it('groups contiguous eligible root tool cards', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected tool group')
        }
        expect(visible[0].tools.map((tool) => tool.id)).toEqual(['grep-1', 'bash-1', 'edit-1'])
        expect(visible[0].defaultOpen).toBe(false)
        expect(visible[0].showAgentIcon).toBe(true)
        expect(visible[0].forceCompact).toBe(true)
        expect(visible[0].summary.fileTargets).toEqual(['src/a.ts'])
        expect(visible[0].summary.commandTargets).toEqual(['bun test'])
    })

    it('splits groups on assistant text boundaries', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1', 'located the issue'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('folds every single noninteractive tool in detailed display mode', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('read-1', 'Read', { file_path: 'src/a.ts' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)
        if (!isToolGroupBlock(visible[0]) || !isToolGroupBlock(visible[2])) {
            throw new Error('expected compact single tool groups')
        }
        expect(visible[0].forceCompact).toBe(true)
        expect(visible[2].forceCompact).toBe(true)
    })

    it('keeps single tool activity compact in compact display mode', () => {
        const runningTool = makeToolBlock('bash-1', 'Bash', { command: 'bun test' }, {
            tool: {
                id: 'bash-1',
                name: 'Bash',
                state: 'running',
                input: { command: 'bun test' },
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: null,
                result: null,
                permission: undefined,
            }
        })
        const completedTool = makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' })
        const visible = buildVisibleChatBlocks([
            runningTool,
            makeTextBlock('text-1'),
            completedTool,
        ], {
            hasMoreMessages: false,
            terminalToolDisplayMode: 'compact'
        })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2])).toBe(true)

        if (!isToolGroupBlock(visible[0]) || !isToolGroupBlock(visible[2])) {
            throw new Error('expected compact single tool groups')
        }
        expect(visible[0].tools).toEqual([runningTool])
        expect(visible[0].summary.runningCount).toBe(1)
        expect(visible[0].forceCompact).toBe(true)
        expect(visible[2].tools).toEqual([completedTool])
        expect(visible[2].summary.totalTools).toBe(1)
        expect(visible[2].forceCompact).toBe(true)
    })

    it('folds titled MCP calls in compact display mode', () => {
        const titledMcp = makeToolBlock(
            'mcp-titled-1',
            'mcp__node_repl__js',
            { title: '查看本地会话', code: 'nodeRepl.write("ok")' }
        )
        const visible = buildVisibleChatBlocks([titledMcp], {
            hasMoreMessages: false,
            terminalToolDisplayMode: 'compact'
        })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected compact MCP tool group')
        }
        expect(visible[0].tools).toEqual([titledMcp])
        expect(visible[0].forceCompact).toBe(true)
    })

    it('keeps interactive cards standalone and uses them as hard boundaries', () => {
        const interactive = makeToolBlock('ask-1', 'request_user_input', {}, {
            tool: {
                id: 'ask-1',
                name: 'request_user_input',
                state: 'pending',
                input: {},
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                description: null,
                result: null,
                permission: {
                    id: 'ask-1',
                    status: 'pending'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            interactive,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(3)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        expect(visible[1]).toBe(interactive)
        expect(isToolGroupBlock(visible[2])).toBe(true)
    })

    it('folds completed Codex permission cards with the surrounding activity', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'completed',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                description: null,
                result: 'Approved',
                permission: {
                    id: 'perm-1',
                    status: 'approved',
                    decision: 'approved'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            permission,
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: false })

        expect(visible).toHaveLength(1)
        expect(isToolGroupBlock(visible[0])).toBe(true)
        if (!isToolGroupBlock(visible[0])) {
            throw new Error('expected compact tool group')
        }
        expect(visible[0].tools.map((tool) => tool.id)).toEqual([
            'grep-1', 'bash-1', 'perm-1', 'edit-1', 'write-1'
        ])
        expect(visible[0].forceCompact).toBe(true)
    })

    it('marks only the oldest visible grouped run as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-1'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(isToolGroupBlock(visible[0]) && visible[0].needsOlderHistory).toBe(true)
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after leading non-tool blocks as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeTextBlock('text-1', 'prepended assistant note'),
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeTextBlock('text-2', 'next section'),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
            makeToolBlock('write-1', 'Write', { file_path: 'src/b.ts' }),
        ], { hasMoreMessages: true })

        expect(visible[0].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
        expect(isToolGroupBlock(visible[3]) && visible[3].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a leading compact tool as needing older history', () => {
        const visible = buildVisibleChatBlocks([
            makeToolBlock('single-1', 'Read', { file_path: 'src/solo.ts' }),
            makeTextBlock('text-1', 'boundary'),
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(isToolGroupBlock(visible[0]) && visible[0].forceCompact).toBe(true)
        expect(visible[1].kind).toBe('agent-text')
        expect(isToolGroupBlock(visible[2]) && visible[2].needsOlderHistory).toBe(false)
    })

    it('does not mark groups after a pending permission boundary as needing older history', () => {
        const permission = makeToolBlock('perm-1', 'CodexPermission', { tool: 'shell_command' }, {
            tool: {
                id: 'perm-1',
                name: 'CodexPermission',
                state: 'pending',
                input: { tool: 'shell_command' },
                createdAt: 1,
                startedAt: null,
                completedAt: null,
                description: null,
                result: null,
                permission: {
                    id: 'perm-1',
                    status: 'pending'
                }
            }
        })
        const visible = buildVisibleChatBlocks([
            permission,
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        expect(visible[0]).toBe(permission)
        expect(isToolGroupBlock(visible[1]) && visible[1].needsOlderHistory).toBe(false)
    })

    it('reuses a previous group id when the first tool changes after prepend', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('grep-2', 'Grep', { pattern: 'bar' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: true })

        const next = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'foo' }),
            makeToolBlock('grep-2', 'Grep', { pattern: 'bar' }),
            makeToolBlock('bash-2', 'Bash', { command: 'bun test' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })

    it('reuses a previous group id when the last tool changes after append', () => {
        const previous = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
        ], { hasMoreMessages: false })

        const next = buildVisibleChatBlocks([
            makeToolBlock('grep-1', 'Grep', { pattern: 'TODO' }),
            makeToolBlock('bash-1', 'Bash', { command: 'bun test' }),
            makeToolBlock('edit-1', 'Edit', { file_path: 'src/a.ts' }),
        ], {
            hasMoreMessages: false,
            previousGroups: previous.filter(isToolGroupBlock)
        })

        expect(isToolGroupBlock(previous[0]) && isToolGroupBlock(next[0]) && previous[0].id === next[0].id).toBe(true)
    })
})
