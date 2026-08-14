import { describe, expect, it } from 'vitest'
import { resolveToolAutoApprovalDecision } from './BasePermissionHandler'

describe('A2A peer permissions', () => {
    it('所有权限模式都要求批准跨会话 inspect 和 ping', () => {
        for (const mode of ['default', 'read-only', 'safe-yolo', 'yolo'] as const) {
            expect(resolveToolAutoApprovalDecision(mode, 'mcp__hapi__inspect_peer', 'inspect')).toBeNull()
            expect(resolveToolAutoApprovalDecision(mode, 'mcp__hapi__ping_peer', 'ping')).toBeNull()
        }
    })

    it('仍自动允许只读 peer discovery', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'mcp__hapi__list_peers', '1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('safe-yolo', 'mcp__hapi__list_peers', '2')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('yolo', 'mcp__hapi__list_peers', '3')).toBe('approved_for_session')
    })
})
