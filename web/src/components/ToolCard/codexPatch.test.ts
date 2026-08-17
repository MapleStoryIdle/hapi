import { describe, expect, it } from 'vitest'
import {
    formatCodexPatchHunk,
    getCodexDiffPaths,
    getCodexPatchChanges,
    getCodexPatchTotals,
    isSameCodexChangedPath
} from '@/components/ToolCard/codexPatch'

describe('Codex patch details', () => {
    it('extracts file paths, diff statistics, and hunk ranges from Codex file changes', () => {
        const changes = getCodexPatchChanges({
            changes: [{
                path: 'web/src/App.tsx',
                kind: { type: 'update', move_path: null },
                diff: [
                    '@@ -32,3 +32,3 @@',
                    ' unchanged',
                    '-old value',
                    '+new value',
                    ' unchanged',
                    '@@ -80,0 +81,2 @@',
                    '+first added line',
                    '+second added line'
                ].join('\n')
            }]
        })

        expect(changes).toHaveLength(1)
        expect(changes[0]).toMatchObject({
            path: 'web/src/App.tsx',
            kind: 'update',
            additions: 3,
            deletions: 1
        })
        expect(changes[0]?.hunks).toEqual([
            { oldStart: 32, oldCount: 3, newStart: 32, newCount: 3 },
            { oldStart: 80, oldCount: 0, newStart: 81, newCount: 2 }
        ])
        expect(formatCodexPatchHunk(changes[0]!.hunks[0]!)).toBe('L32–34 → L32–34')
        expect(formatCodexPatchHunk(changes[0]!.hunks[1]!)).toBe('L80 (empty) → L81–82')
        expect(getCodexPatchTotals(changes)).toEqual({ additions: 3, deletions: 1 })
    })

    it('keeps normalized map-shaped changes readable for new sessions', () => {
        const changes = getCodexPatchChanges({
            changes: {
                'web/src/new.ts': {
                    kind: { type: 'add', move_path: null },
                    diff: '@@ -0,0 +1,2 @@\n+export const one = 1\n+export const two = 2\n'
                }
            }
        })

        expect(changes).toMatchObject([{
            path: 'web/src/new.ts',
            kind: 'add',
            additions: 2,
            deletions: 0,
            hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 }]
        }])
    })

    it('extracts paths from a cumulative Codex diff and matches absolute patch paths', () => {
        const paths = getCodexDiffPaths({
            unified_diff: [
                'diff --git a/web/src/App.tsx b/web/src/App.tsx',
                '--- a/web/src/App.tsx',
                '+++ b/web/src/App.tsx',
                '@@ -1 +1 @@',
                '-old',
                '+new',
                'diff --git a/web/src/removed.ts b/web/src/removed.ts',
                '--- a/web/src/removed.ts',
                '+++ /dev/null',
                '@@ -1 +0,0 @@',
                '-gone'
            ].join('\n')
        })

        expect(paths).toEqual(['web/src/App.tsx', 'web/src/removed.ts'])
        expect(isSameCodexChangedPath('/workspace/hapi/web/src/App.tsx', 'web/src/App.tsx')).toBe(true)
    })
})
