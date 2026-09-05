import { describe, expect, it } from 'vitest'
import { getToolPresentation } from '@/components/ToolCard/knownTools'

describe('getToolPresentation — MCP invocation titles', () => {
    it('shows an MCP-provided title as the visible action label', () => {
        const presentation = getToolPresentation({
            toolName: 'mcp__node_repl__js',
            input: {
                title: '查看本地会话',
                code: 'await viewportCapability.set({ width: 390, height: 844 })',
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('查看本地会话')
        expect(presentation.subtitle).toBe('MCP: Node Repl Js')
        expect(presentation.minimal).toBe(true)
    })

    it('keeps the MCP tool name when no usable title is provided', () => {
        const presentation = getToolPresentation({
            toolName: 'mcp__node_repl__js',
            input: { title: '   ', code: 'nodeRepl.write("ok")' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('MCP: Node Repl Js')
        expect(presentation.subtitle).toBeNull()
    })
})

describe('getToolPresentation — file access semantics', () => {
    it('labels native Grep operations as grep', () => {
        const presentation = getToolPresentation({
            toolName: 'Grep',
            input: { pattern: 'TODO', path: 'web/src' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({ title: 'grep', subtitle: null, minimal: true })
    })

    it('shows native Read path and actual line range directly', () => {
        const presentation = getToolPresentation({
            toolName: 'Read',
            input: { file_path: 'web/src/App.tsx', offset: 12, limit: 69 },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('App.tsx · L12–80')
    })

    it('normalizes ReadFile aliases to a basename-only file message', () => {
        const presentation = getToolPresentation({
            toolName: 'read_file',
            input: { file_path: '/workspace/web/src/App.tsx' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({ title: 'Read file', subtitle: 'App.tsx' })
    })

    it('labels only simple Codex shell reads as a request', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: { command: "/bin/zsh -lc \"sed -n '12,80p' web/src/App.tsx\"" },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('App.tsx · L12–80')
    })

    it('reduces compound Codex terminal commands to their key command', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: { command: 'cd web && cat src/App.tsx', parsed_cmd: [{ type: 'read', name: 'src/App.tsx' }] },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('cat src/App.tsx')
        expect(presentation.subtitle).toBeNull()
    })

    it('lists explicit read targets from a sequential Codex shell request', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: {
                command: `/bin/zsh -lc "cat /workspace/AGENT.md && printf '%s' ready && sed -n '12,80p' web/src/App.tsx"`
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('AGENT.md · App.tsx · L12–80')
    })

    it('shows safe remote, SQL, request, and file targets without raw arguments', () => {
        const cases = [
            {
                command: 'ssh deploy@192.0.2.18 systemctl status hapi-hub.service',
                title: 'ssh',
                subtitle: '192.0.2.18'
            },
            {
                command: `mysql -D lingda_dev -e "SELECT * FROM sys_user WHERE token = 'secret'"`,
                title: 'Execute SQL',
                subtitle: 'lingda_dev.sys_user'
            },
            {
                command: `curl -X POST 'https://user:password@example.com/api/status?token=secret'`,
                title: 'POST',
                subtitle: 'example.com/api/status'
            },
            {
                command: 'rm web/src/cache.json',
                title: 'Manage files',
                subtitle: 'cache.json'
            }
        ]

        for (const item of cases) {
            const presentation = getToolPresentation({
                toolName: 'CodexBash',
                input: { command: item.command },
                result: null,
                childrenCount: 0,
                description: null,
                metadata: null,
            })
            expect(presentation).toMatchObject({ title: item.title, subtitle: item.subtitle })
            expect(`${presentation.title} ${presentation.subtitle}`).not.toContain('secret')
            expect(`${presentation.title} ${presentation.subtitle}`).not.toContain('password')
            expect(`${presentation.title} ${presentation.subtitle}`).not.toContain('web/src')
        }
    })

    it('names clear non-file Codex terminal work without hiding its output', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: { command: '/bin/zsh -lc "git -C /workspace/hapi status --short"' },
            result: { stdout: ' M web/src/App.tsx' },
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({
            title: 'git status',
            subtitle: null,
            minimal: false
        })
    })

    it('uses the actual Bun command instead of an abstract execution label', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: { command: '/bin/zsh -lc "bun run typecheck && bun run test"' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({
            title: 'bun run typecheck · bun run test',
            subtitle: null
        })
    })

    it('uses a safe runtime title without exposing inline code', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexBash',
            input: { command: '/bin/zsh -lc "node -e \'process.exit(0)\'"' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({
            title: 'Run Node.js',
            subtitle: null
        })
        expect(presentation.title).not.toContain('process.exit')
    })

    it('semanticizes only structured MCP reads and patches', () => {
        const read = getToolPresentation({
            toolName: 'mcp__filesystem__read_lines',
            input: { path: 'web/src/App.tsx', startLine: 12, endLine: 80 },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const patch = getToolPresentation({
            toolName: 'mcp__filesystem__apply_patch',
            input: {
                patch: '*** Begin Patch\n*** Update File: web/src/App.tsx\n@@\n-old\n+new\n*** End Patch'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })
        const generic = getToolPresentation({
            toolName: 'mcp__filesystem__inspect',
            input: { title: 'Inspect file', path: 'web/src/App.tsx' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(read).toMatchObject({ title: 'Read file', subtitle: 'App.tsx · L12–80' })
        expect(patch).toMatchObject({ title: 'Modify file', subtitle: 'App.tsx · +1 −1' })
        expect(generic).toMatchObject({ title: 'Inspect file', subtitle: 'MCP: Filesystem Inspect' })
    })
})

describe('getToolPresentation — Codex patch details', () => {
    it('summarizes actual file changes and exposes the inline patch view', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexPatch',
            input: {
                changes: [{
                    path: '/workspace/web/src/App.tsx',
                    kind: { type: 'update', move_path: null },
                    diff: '@@ -32,2 +32,3 @@\n old\n-old value\n+new value\n+another line\n'
                }]
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({ title: 'Modify file', subtitle: 'App.tsx · +2 −1' })
        expect(presentation.minimal).toBe(false)
    })

    it('names native file mutations with their target path', () => {
        const presentation = getToolPresentation({
            toolName: 'Edit',
            input: { file_path: 'web/src/App.tsx' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation).toMatchObject({ title: 'Modify file', subtitle: 'web/src/App.tsx' })
    })
})

describe('getToolPresentation — unknown tool semantic title + subtitle dedup', () => {
    it('promotes semantic title "Run shell" when toolName equals input.command (Gemini ACP case)', () => {
        const presentation = getToolPresentation({
            toolName: 'cat /tmp/hello.txt',
            input: { command: 'cat /tmp/hello.txt' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Run shell')
        expect(presentation.subtitle).toBe('cat /tmp/hello.txt')
    })

    it('promotes semantic title "Read file" when toolName equals input.file_path', () => {
        const presentation = getToolPresentation({
            toolName: 'README.md',
            input: { file_path: 'README.md' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('README.md')
    })

    it('promotes semantic title "Search" when toolName equals input.pattern', () => {
        const presentation = getToolPresentation({
            toolName: '*.ts',
            input: { pattern: '*.ts' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Search')
        expect(presentation.subtitle).toBe('*.ts')
    })

    it('keeps the original toolName when subtitle differs (no promotion needed)', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('run_shell_command')
        expect(presentation.subtitle).toBe('ls -la /tmp')
    })

    it('uses input.name as a fallback subtitle for unknown tool cards', () => {
        const presentation = getToolPresentation({
            toolName: 'Tool',
            input: { name: 'Tool 1' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Tool')
        expect(presentation.subtitle).toBe('Tool 1')
    })

    it('returns null subtitle when no recognized input field is present', () => {
        const presentation = getToolPresentation({
            toolName: 'mystery_tool',
            input: { foo: 'bar' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('mystery_tool')
        expect(presentation.subtitle).toBeNull()
    })
})

describe('getToolPresentation — Codex agent tools', () => {
    it('titles CodexAgent cards from work summary instead of agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                agentId: 'agent-1234567890',
                summary: '检查 Hub Web README',
                activity: 'Reading file: README.md',
                reasoning_effort: 'medium'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: 检查 Hub Web README')
        expect(presentation.title).not.toContain('agent-1234567890')
        expect(presentation.subtitle).toBe('reasoning medium · Reading file: README.md')
        expect(presentation.minimal).toBe(true)
    })

    it('shows Codex auto-selected effort on CodexAgent cards even before activity is available', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                summary: 'Inspect package metadata',
                reasoning_effort: 'low'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: Inspect package metadata')
        expect(presentation.subtitle).toBe('reasoning low')
    })

    it('does not present sub-operation completion as final agent completion while still running', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                summary: 'Inspect package metadata',
                agentStatus: 'running',
                activity: 'Command completed: bun test',
                reasoning_effort: 'low'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.subtitle).toBe('reasoning low · Command finished: bun test')
    })

    it('falls back to prompt-derived CodexAgent titles without exposing agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'CodexAgent',
            input: {
                agentId: 'agent-1234567890',
                message: 'Fix the reducer for live agent cards.\nDo not revert other changes.'
            },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Agent: Fix the reducer for live agent cards.')
        expect(presentation.title).not.toContain('agent-1234567890')
    })

    it('summarizes spawn_agent with the spawned agent id', () => {
        const presentation = getToolPresentation({
            toolName: 'spawn_agent',
            input: {
                agent_type: 'worker',
                message: 'Implement the parser'
            },
            result: '{"agent_id":"agent-123","nickname":"Raman"}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Spawn worker agent')
        expect(presentation.subtitle).toBe('Launched Raman (agent-123)')
        expect(presentation.minimal).toBe(true)
    })

    it('summarizes wait_agent status counts', () => {
        const presentation = getToolPresentation({
            toolName: 'wait_agent',
            input: {
                targets: ['a', 'b'],
                timeout_ms: 30000
            },
            result: '{"status":{"a":{"completed":"done"},"b":{"failed":"boom"}},"timed_out":false}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Wait for 2 agents')
        expect(presentation.subtitle).toBe('1 completed, 1 non-completed')
        expect(presentation.minimal).toBe(true)
    })

    it('does not expose close_agent previous output in the collapsed subtitle', () => {
        const presentation = getToolPresentation({
            toolName: 'close_agent',
            input: {
                target: 'agent-123'
            },
            result: '{"previous_status":{"completed":"hidden child output"}}',
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Close agent')
        expect(presentation.subtitle).toBe('Closed (completed)')
        expect(presentation.subtitle).not.toContain('hidden child output')
        expect(presentation.minimal).toBe(true)
    })
})
