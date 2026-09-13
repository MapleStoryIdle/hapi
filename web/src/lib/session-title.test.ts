import { describe, expect, it } from 'vitest'
import { getSessionDisplayTitle } from './session-title'

describe('getSessionDisplayTitle', () => {
    it('uses the session detail title priority everywhere', () => {
        expect(getSessionDisplayTitle({
            id: 'session-12345678',
            metadata: {
                name: 'Renamed session',
                summary: { text: 'Generated summary' },
                path: '/workspace/project'
            }
        })).toBe('Renamed session')
        expect(getSessionDisplayTitle({
            id: 'session-12345678',
            metadata: { summary: { text: 'Generated summary' }, path: '/workspace/project' }
        })).toBe('Generated summary')
        expect(getSessionDisplayTitle({
            id: 'session-12345678',
            metadata: { path: '/workspace/project' }
        })).toBe('project')
        expect(getSessionDisplayTitle({ id: 'session-12345678' })).toBe('session-')
    })

    it('does not replace the detail title with a worktree base path', () => {
        expect(getSessionDisplayTitle({
            id: 'session-12345678',
            metadata: {
                path: '/workspace/task-worktree',
                worktree: { basePath: '/workspace/main-project' }
            }
        })).toBe('task-worktree')
    })
})
