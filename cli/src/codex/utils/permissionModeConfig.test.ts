import { describe, expect, it } from 'vitest';
import { buildCodexPermissionModeCliArgs, resolveCodexPermissionModeConfig } from './permissionModeConfig';

describe('resolveCodexPermissionModeConfig', () => {
    it('uses on-request approvals for default mode', () => {
        expect(resolveCodexPermissionModeConfig('default')).toEqual({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'user',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
    });

    it('uses the Codex auto reviewer for safe-yolo', () => {
        expect(resolveCodexPermissionModeConfig('safe-yolo')).toEqual({
            approvalPolicy: 'on-request',
            approvalsReviewer: 'auto_review',
            sandbox: 'workspace-write',
            sandboxPolicy: { type: 'workspaceWrite' }
        });
        expect(buildCodexPermissionModeCliArgs('safe-yolo')).toEqual(['--approve-for-me']);
    });
});
