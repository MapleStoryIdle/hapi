import type { CodexPermissionMode } from '@hapi/protocol/types';
import type { ApprovalPolicy, ApprovalsReviewer, SandboxMode, SandboxPolicy } from '../appServerTypes';

export type CodexPermissionModeConfig = {
    approvalPolicy: ApprovalPolicy;
    approvalsReviewer: ApprovalsReviewer;
    sandbox: SandboxMode;
    sandboxPolicy: SandboxPolicy;
};

export function resolveCodexPermissionModeConfig(mode: CodexPermissionMode): CodexPermissionModeConfig {
    switch (mode) {
        case 'default':
            return {
                // Remote Codex sessions rely on SHAPI's approval UI for sandbox escalation.
                // `on-request` keeps workspace-write sandboxing while still surfacing a
                // user-approvable elevation request when the model needs it.
                approvalPolicy: 'on-request',
                approvalsReviewer: 'user',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' }
            };
        case 'read-only':
            return {
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                sandbox: 'read-only',
                sandboxPolicy: { type: 'readOnly' }
            };
        case 'safe-yolo':
            return {
                // Codex 0.153+ replaces the removed `on-failure` policy with
                // on-request approvals reviewed automatically by Codex.
                approvalPolicy: 'on-request',
                approvalsReviewer: 'auto_review',
                sandbox: 'workspace-write',
                sandboxPolicy: { type: 'workspaceWrite' }
            };
        case 'yolo':
            return {
                approvalPolicy: 'never',
                approvalsReviewer: 'user',
                sandbox: 'danger-full-access',
                sandboxPolicy: { type: 'dangerFullAccess' }
            };
    }

    const unexpectedMode: never = mode;
    throw new Error(`Unknown permission mode: ${unexpectedMode}`);
}

export function buildCodexPermissionModeCliArgs(mode: Exclude<CodexPermissionMode, 'default'>): string[] {
    if (mode === 'safe-yolo') {
        return ['--approve-for-me'];
    }
    const config = resolveCodexPermissionModeConfig(mode);
    return ['--ask-for-approval', config.approvalPolicy, '--sandbox', config.sandbox];
}
