import { describe, expect, it } from 'vitest'
import {
    formatFileReadTarget,
    getMcpPatchTarget,
    getMcpReadTarget,
    getNativeReadTarget,
    getTerminalReadRequest,
    getTerminalReadRequests
} from '@/components/ToolCard/fileAccess'

describe('file access targets', () => {
    it('derives an actual native Read range from offset and limit', () => {
        const target = getNativeReadTarget({ file_path: 'web/src/App.tsx', offset: 12, limit: 69 })

        expect(target).toEqual({
            path: 'web/src/App.tsx',
            lineRange: { start: 12, end: 80 }
        })
        expect(target && formatFileReadTarget(target, target.path)).toBe('web/src/App.tsx · L12–80')
    })

    it('recognizes only simple sed and cat terminal read requests', () => {
        expect(getTerminalReadRequest({
            command: "/bin/zsh -lc \"sed -n '12,80p' web/src/App.tsx\""
        })).toEqual({
            path: 'web/src/App.tsx',
            lineRange: { start: 12, end: 80 }
        })
        expect(getTerminalReadRequest({ command: "/bin/zsh -lc 'cat web/src/App.tsx'" })).toEqual({
            path: 'web/src/App.tsx',
            lineRange: null
        })
        expect(getTerminalReadRequest({ command: "sed -n '12,80p' web/src/App.tsx | head" })).toBeNull()
        expect(getTerminalReadRequest({ command: 'cd web && cat src/App.tsx' })).toBeNull()
    })

    it('names explicit read segments in a sequential terminal script as requests', () => {
        expect(getTerminalReadRequests({
            command: `/bin/zsh -lc "cat /workspace/AGENT.md && printf '%s' ready && sed -n '12,80p' web/src/App.tsx"`
        })).toEqual([
            { path: '/workspace/AGENT.md', lineRange: null },
            { path: 'web/src/App.tsx', lineRange: { start: 12, end: 80 } }
        ])
    })

    it('keeps explicit reads when another script segment has a pipeline', () => {
        expect(getTerminalReadRequests({
            command: `/bin/zsh -lc "cat package.json; find src -type f | sort; sed -n '1,220p' README.md"`
        })).toEqual([
            { path: 'package.json', lineRange: null },
            { path: 'README.md', lineRange: { start: 1, end: 220 } }
        ])
    })

    it('requires structured MCP read and patch inputs', () => {
        expect(getMcpReadTarget({ path: 'web/src/App.tsx', startLine: 12, endLine: 80 })).toEqual({
            path: 'web/src/App.tsx',
            lineRange: { start: 12, end: 80 }
        })
        expect(getMcpReadTarget({ path: 'web/src/App.tsx' })).toBeNull()

        expect(getMcpPatchTarget({
            patch: [
                '*** Begin Patch',
                '*** Update File: web/src/App.tsx',
                '@@',
                '-old',
                '+new',
                '*** End Patch'
            ].join('\n')
        })).toEqual({
            path: 'web/src/App.tsx',
            fileCount: 1,
            additions: 1,
            deletions: 1
        })
        expect(getMcpPatchTarget({ path: 'web/src/App.tsx', patch: 'replace the title' })).toBeNull()
    })
})
