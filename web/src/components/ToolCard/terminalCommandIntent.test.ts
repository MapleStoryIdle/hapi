import { describe, expect, it } from 'vitest'
import { getTerminalCommandIntent, getTerminalCommandIntentLabel, getTerminalCommandIntentTitle, getTerminalCommandSummary, usesTerminalCommandAsLabel } from '@/components/ToolCard/terminalCommandIntent'

describe('terminal command intent', () => {
    it('keeps shell file reads as requests and includes their explicit targets', () => {
        expect(getTerminalCommandIntent({
            command: `/bin/zsh -lc "cat package.json; find src -type f | sort; sed -n '1,220p' README.md"`
        })).toEqual({
            kind: 'read-request',
            targets: [
                { path: 'package.json', lineRange: null },
                { path: 'README.md', lineRange: { start: 1, end: 220 } }
            ]
        })
    })

    it.each([
        ['bun run typecheck && bun run test', 'run-checks'],
        ['bunx vitest run src/App.test.tsx', 'run-tests'],
        ['rg -n "ToolGroupCard" web/src', 'search-files'],
        ['git -C /workspace/hapi status --short; git diff --stat', 'inspect-git'],
        ['find web/src -type f | sort', 'browse-files'],
        ['bun run build', 'build-project']
    ] as const)('classifies %s as %s', (command, kind) => {
        expect(getTerminalCommandIntent({ command })).toEqual({ kind })
    })

    it('leaves unknown or potentially mutating shell commands generic', () => {
        expect(getTerminalCommandIntent({ command: 'node scripts/rewrite.mjs' })).toBeNull()
        expect(getTerminalCommandIntent({ command: 'find . -name tmp -delete' })).toBeNull()
    })

    it('uses clear fallback titles outside the translation provider', () => {
        const intent = getTerminalCommandIntent({ command: 'git diff -- web/src/App.tsx' })
        expect(intent && getTerminalCommandIntentTitle(intent)).toBe('Inspect Git')
    })

    it('uses the native read-file title for terminal read requests', () => {
        const intent = getTerminalCommandIntent({ command: "sed -n '12,80p' web/src/App.tsx" })
        const receivedKeys: string[] = []

        expect(intent && getTerminalCommandIntentTitle(intent, (key) => {
            receivedKeys.push(key)
            return '读取文件'
        })).toBe('读取文件')
        expect(receivedKeys).toEqual(['tool.semanticTitle.readFile'])
    })

    it('uses the actual package command as the label for runnable project scripts', () => {
        const input = { command: '/bin/zsh -lc "echo start; bun run typecheck && bun run test; printf done"' }
        const intent = getTerminalCommandIntent(input)

        expect(intent && usesTerminalCommandAsLabel(intent)).toBe(true)
        expect(intent && getTerminalCommandIntentLabel(input, intent)).toBe('bun run typecheck · bun run test')
    })

    it('keeps one or two recognized commands instead of the full shell script', () => {
        expect(getTerminalCommandSummary({
            command: 'git -C /workspace/hapi status --short; rg -n "ToolGroupCard" web/src; echo done'
        })).toBe('git status · rg')
        expect(getTerminalCommandSummary({
            command: 'node scripts/rewrite.mjs --verbose --all'
        })).toBeNull()
        expect(getTerminalCommandSummary({
            command: 'apply_patch <<PATCH\n*** Begin Patch'
        })).toBe('apply_patch')
        expect(getTerminalCommandSummary({
            command: '/bin/zsh -lc "sed -n \'1,20p\' src/App.tsx; for f in src/a.ts; do echo $f; done\''
        })).toBe('sed -n')
    })
})
