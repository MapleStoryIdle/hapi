import React from 'react';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { detectImageMimeType, readImageHeader, registerGeneratedImage } from '@/modules/common/generatedImages';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import type { ReviewTarget, ThreadGoal, ThreadGoalStatus } from './appServerTypes';
import { shouldIgnoreTerminalEvent } from './utils/terminalEventGuard';
import { parseCodexSpecialCommand } from './codexSpecialCommands';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';


async function registerGeneratedImageFromPath(args: { id: string; path: string; fileName?: string | null }): Promise<ReturnType<typeof registerGeneratedImage> | null> {
    try {
        const info = await lstat(args.path);
        if (!info.isFile()) {
            throw new Error('Path is not a regular file');
        }
        const maxImageBytes = 25 * 1024 * 1024;
        if (info.size > maxImageBytes) {
            throw new Error('Image is too large to display inline');
        }
        const header = await readImageHeader(args.path);
        const mimeType = detectImageMimeType(header);
        if (!mimeType) {
            throw new Error('Unsupported image content');
        }
        return registerGeneratedImage({
            id: args.id,
            path: args.path,
            fileName: args.fileName,
            mimeType,
            size: info.size,
            mtimeMs: info.mtimeMs
        });
    } catch (error) {
        logger.debug('[CodexRemoteLauncher] Failed to register generated image:', error instanceof Error ? error.message : String(error));
        return null;
    }
}

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];
type QueuedMessage = { message: string; mode: EnhancedMode; isolate: boolean; hash: string };
type PendingSideSessionFork = {
    callId: string | null;
    parentThreadId: string;
    timeout: ReturnType<typeof setTimeout>;
    resolve: (value: {
        childCodexThreadId: string;
        parentCodexThreadId: string;
    }) => void;
    reject: (error: Error) => void;
};
type CodexTaskStatusCode = 'system_error' | 'network_error' | 'usage_limit' | 'model_capacity' | 'context_window' | 'unknown';
type CodexTaskStatusEvent = {
    type: 'task-status';
    status: 'retrying' | 'compacting' | 'compacted' | 'failed';
    source: 'codex';
    code: CodexTaskStatusCode;
    message: string;
    retryAttempt?: number;
    maxRetries?: number;
    recoverable: boolean;
    actionUrl?: string;
    resetAtText?: string;
};
type ChildAgentRuntime = {
    reasoningProcessor: ReasoningProcessor;
    diffProcessor: DiffProcessor;
    toolStartedAtByCallId: Map<string, number>;
    activeToolsByCallId: Map<string, {
        name: string;
        label: string;
        activity: string;
        activityKind: string;
    }>;
    pendingTitleByCallId: Map<string, string>;
    reasoningPreview: string;
    finalMessage: string | null;
    terminal: boolean;
    blockedNestedAgent: boolean;
};

type CodexSubagentSnapshot = {
    id: string;
    cardId?: string;
    threadId?: string;
    turnId?: string;
    type?: string;
    title?: string;
    summary?: string;
    status: string;
    statusText?: string;
    activity?: string;
    activityKind?: string;
    startedAt: number;
    updatedAt: number;
    completedAt?: number;
};

type CodexSubagentConfiguration = {
    childModel?: string;
    childReasoningEffort?: string;
};

const AGENT_RUN_UPDATE_THROTTLE_MS = 300;
const AGENT_RUN_START_TIMEOUT_MS = 30 * 1000;
const SIDE_SESSION_FORK_TIMEOUT_MS = 60 * 1000;
const SUBAGENT_STATE_FLUSH_DEBOUNCE_MS = 250;
const THROTTLED_AGENT_RUN_ACTIVITY_KINDS = new Set(['thinking']);
const CODEX_SPAWN_AGENT_FULL_HISTORY_ARGUMENT_ERROR =
    'Full-history forked agents inherit the parent agent type, model, and reasoning effort; ' +
    'omit agent_type, model, and reasoning_effort, or spawn without a full-history fork.';

const SAME_THREAD_RETRYABLE_ERROR_PATTERNS = [
    'selected model is at capacity',
    'codex thread entered systemerror'
];
const CONTEXT_COMPACT_RETRYABLE_ERROR_PATTERNS = [
    'ran out of room in the model',
    'context window',
    'clear earlier history'
];
const NETWORK_ERROR_PATTERNS = [
    'network error',
    'network request failed',
    'failed to fetch',
    'fetch failed',
    'error sending request',
    'stream disconnected before completion',
    'connection reset',
    'connection refused',
    'connection timed out',
    'connection timeout',
    'network is unreachable',
    'network unreachable',
    'socket hang up',
    'could not resolve host',
    'dns error',
    'econnreset',
    'econnrefused',
    'etimedout',
    'enotfound',
    'eai_again'
];
const SAME_THREAD_MAX_RETRIES = 3;
const SAME_THREAD_MAX_COMPACT_RETRIES = 1;
const SAME_THREAD_COMPACT_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_USAGE_SETTINGS_URL = 'https://chatgpt.com/codex/settings/usage';
const CODEX_GOALS_UNSUPPORTED_MESSAGE = 'Codex goals are not supported by this Codex runtime. Upgrade Codex or enable features.goals.';
const MAX_CODEX_GOAL_OBJECTIVE_CHARS = 4_000;

type GoalForwardSignature = {
    objective: string | null;
    status: string | null;
    tokenBudget: number | null;
    tokenBucket: number | null;
};

type CompletedToolTiming = {
    completedAt: number;
    durationMs?: number;
};

function beginToolTiming(toolStartedAtByCallId: Map<string, number>, callId: string): number {
    const existingStartedAt = toolStartedAtByCallId.get(callId);
    if (existingStartedAt !== undefined) {
        return existingStartedAt;
    }

    const startedAt = Date.now();
    toolStartedAtByCallId.set(callId, startedAt);
    return startedAt;
}

function completeToolTiming(toolStartedAtByCallId: Map<string, number>, callId: string): CompletedToolTiming {
    const completedAt = Date.now();
    const startedAt = toolStartedAtByCallId.get(callId);
    toolStartedAtByCallId.delete(callId);

    return {
        completedAt,
        ...(startedAt === undefined ? {} : { durationMs: Math.max(0, completedAt - startedAt) })
    };
}

function goalNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function goalString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function buildGoalForwardSignature(goal: Record<string, unknown>): GoalForwardSignature {
    const tokenBudget = goalNumber(goal.tokenBudget ?? goal.token_budget);
    const tokensUsed = goalNumber(goal.tokensUsed ?? goal.tokens_used) ?? 0;
    const tokenBucket = tokenBudget !== null && tokenBudget > 0
        ? Math.floor(Math.min(tokensUsed, tokenBudget) / Math.max(1, tokenBudget * 0.05))
        : null;

    return {
        objective: goalString(goal.objective),
        status: goalString(goal.status),
        tokenBudget,
        tokenBucket
    };
}

function goalForwardSignatureKey(signature: GoalForwardSignature): string {
    return JSON.stringify(signature);
}

function isSameThreadRetryableCodexError(error: string | null): boolean {
    if (!error) {
        return false;
    }
    const normalized = error.toLowerCase();
    return SAME_THREAD_RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isContextCompactRetryableCodexError(error: string | null): boolean {
    if (!error) {
        return false;
    }
    const normalized = error.toLowerCase();
    return CONTEXT_COMPACT_RETRYABLE_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function isNetworkCodexError(error: string | null): boolean {
    if (!error) {
        return false;
    }
    const normalized = error.toLowerCase();
    return NETWORK_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function extractCodexUsageActionUrl(error: string): string | null {
    const match = error.match(/https:\/\/chatgpt\.com\/codex\/settings\/usage[^\s)]*/i);
    return match?.[0] ?? null;
}

function extractCodexUsageResetAtText(error: string): string | null {
    const match = error.match(/\btry again at\s+([^.\n]+)/i);
    return match?.[1]?.trim() ?? null;
}

function classifyCodexTaskFailure(error: string | null): {
    code: CodexTaskStatusCode;
    actionUrl?: string;
    resetAtText?: string;
} {
    if (!error) {
        return { code: 'unknown' };
    }

    const normalized = error.toLowerCase();
    if (
        normalized.includes('usage limit')
        || normalized.includes('purchase more credits')
        || normalized.includes('codex/settings/usage')
    ) {
        return {
            code: 'usage_limit',
            actionUrl: extractCodexUsageActionUrl(error) ?? CODEX_USAGE_SETTINGS_URL,
            resetAtText: extractCodexUsageResetAtText(error) ?? undefined
        };
    }
    if (normalized.includes('selected model is at capacity')) {
        return { code: 'model_capacity' };
    }
    if (normalized.includes('codex thread entered systemerror')) {
        return { code: 'system_error' };
    }
    if (isContextCompactRetryableCodexError(error) || normalized.includes('same-conversation compact')) {
        return { code: 'context_window' };
    }
    if (isNetworkCodexError(error)) {
        return { code: 'network_error' };
    }
    return { code: 'unknown' };
}

function buildCodexTaskStatusEvent(args: {
    status: CodexTaskStatusEvent['status'];
    message: string;
    retryAttempt?: number;
    maxRetries?: number;
    recoverable: boolean;
    code?: CodexTaskStatusCode;
}): CodexTaskStatusEvent {
    const classified = classifyCodexTaskFailure(args.message);
    return {
        type: 'task-status',
        status: args.status,
        source: 'codex',
        code: args.code ?? classified.code,
        message: args.message,
        ...(args.retryAttempt !== undefined ? { retryAttempt: args.retryAttempt } : {}),
        ...(args.maxRetries !== undefined ? { maxRetries: args.maxRetries } : {}),
        recoverable: args.recoverable,
        ...(classified.actionUrl ? { actionUrl: classified.actionUrl } : {}),
        ...(classified.resetAtText ? { resetAtText: classified.resetAtText } : {})
    };
}

function formatGoalStatus(status: unknown): string {
    switch (status) {
        case 'active':
            return 'active';
        case 'paused':
            return 'paused';
        case 'budgetLimited':
            return 'limited by budget';
        case 'complete':
            return 'complete';
        default:
            return typeof status === 'string' ? status : 'updated';
    }
}

function formatGoalUsage(goal: ThreadGoal): string {
    const parts: string[] = [`Goal ${formatGoalStatus(goal.status)}`];
    if (goal.tokenBudget !== null && goal.tokenBudget !== undefined) {
        parts.push(`${goal.tokensUsed}/${goal.tokenBudget} tokens`);
    } else if (goal.tokensUsed > 0) {
        parts.push(`${goal.tokensUsed} tokens`);
    }
    return parts.join(' · ');
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, '');
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly appServerClient: CodexAppServerClient;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;
    private readonly activeChildTurns = new Map<string, string>();

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.appServerClient = new CodexAppServerClient();
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async interruptActiveTurns(reason: string): Promise<void> {
        const turnsToInterrupt = [
            ...(this.currentThreadId && this.currentTurnId
                ? [{ threadId: this.currentThreadId, turnId: this.currentTurnId, role: 'parent' as const }]
                : []),
            ...Array.from(this.activeChildTurns, ([threadId, turnId]) => ({
                threadId,
                turnId,
                role: 'child' as const
            }))
        ];

        if (turnsToInterrupt.length === 0) {
            return;
        }

        const results = await Promise.allSettled(
            turnsToInterrupt.map((target) => this.appServerClient.interruptTurn({
                threadId: target.threadId,
                turnId: target.turnId
            }))
        );

        results.forEach((result, index) => {
            const target = turnsToInterrupt[index];
            if (result.status === 'fulfilled') {
                if (target.role === 'child') {
                    this.activeChildTurns.delete(target.threadId);
                }
                return;
            }

            logger.debug(
                `[Codex] Error interrupting ${target.role} app-server turn ` +
                `for ${reason}; threadId=${target.threadId} turnId=${target.turnId}:`,
                result.reason
            );
        });
    }

    private async handleAbort(): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            await this.interruptActiveTurns('abort');
            this.currentTurnId = null;

            this.abortController.abort();
            this.session.queue.reset();
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            this.abortController = new AbortController();
        }
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const appServerClient = this.appServerClient;
        const appServerEventConverter = new AppServerEventConverter();

        const normalizeCommand = (value: unknown): string | undefined => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed : undefined;
            }
            if (Array.isArray(value)) {
                const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
                return joined.length > 0 ? joined : undefined;
            }
            return undefined;
        };

        const asRecord = (value: unknown): Record<string, unknown> | null => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            return value as Record<string, unknown>;
        };

        const asString = (value: unknown): string | null => {
            return typeof value === 'string' && value.length > 0 ? value : null;
        };

        const errorMessage = (error: unknown): string => {
            return error instanceof Error ? error.message : String(error);
        };

        const extractSpawnAgentStartErrorFromStderr = (text: string): string | null => {
            const cleanText = stripAnsi(text);
            return cleanText.includes(CODEX_SPAWN_AGENT_FULL_HISTORY_ARGUMENT_ERROR)
                ? CODEX_SPAWN_AGENT_FULL_HISTORY_ARGUMENT_ERROR
                : null;
        };

        const isExitPlanModeTool = (toolName: string): boolean => {
            return toolName === 'exit_plan_mode' || toolName === 'ExitPlanMode';
        };

        const shouldRetryWithoutCollaborationMode = (error: unknown): boolean => {
            const message = errorMessage(error).toLowerCase();
            const mentionsCollaborationMode = message.includes('collaborationmode')
                || message.includes('collaboration_mode')
                || message.includes('collaboration mode');
            if (!mentionsCollaborationMode) {
                return false;
            }

            return message.includes('experimentalapi')
                || message.includes('unsupported')
                || message.includes('unknown')
                || message.includes('unrecognized')
                || message.includes('unexpected')
                || message.includes('invalid field');
        };

        const responseContainsPlanCollaborationMode = (response: unknown): boolean => {
            const record = asRecord(response);
            const candidates = [
                Array.isArray(response) ? response : undefined,
                Array.isArray(record?.data) ? record.data : undefined,
                Array.isArray(record?.modes) ? record.modes : undefined,
                Array.isArray(record?.collaborationModes) ? record.collaborationModes : undefined,
                Array.isArray(record?.items) ? record.items : undefined
            ];

            for (const candidate of candidates) {
                if (!candidate) continue;
                for (const entry of candidate) {
                    if (entry === 'plan') {
                        return true;
                    }
                    const entryRecord = asRecord(entry);
                    const mode = asString(entryRecord?.mode)
                        ?? asString(entryRecord?.name)
                        ?? asString(entryRecord?.id);
                    if (mode === 'plan') {
                        return true;
                    }
                }
            }

            return false;
        };

        const applyResolvedModel = (value: unknown): string | undefined => {
            const resolvedModel = asString(value) ?? undefined;
            if (!resolvedModel) {
                return undefined;
            }
            session.setModel(resolvedModel);
            logger.debug(`[Codex] Resolved app-server model: ${resolvedModel}`);
            return resolvedModel;
        };

        const applyForkedThreadConfiguration = (response: unknown): void => {
            const record = asRecord(response);
            applyResolvedModel(record?.model);

            const reasoningEffort = asString(record?.reasoningEffort ?? record?.reasoning_effort);
            if (reasoningEffort) {
                session.setModelReasoningEffort(reasoningEffort);
            }

            const serviceTier = record?.serviceTier ?? record?.service_tier;
            if (serviceTier === 'priority' || serviceTier === 'fast') {
                session.setServiceTier('fast');
            } else if (serviceTier === null || serviceTier === 'standard') {
                session.setServiceTier('standard');
            }
        };

        const buildMcpToolName = (server: unknown, tool: unknown): string | null => {
            const serverName = asString(server);
            const toolName = asString(tool);
            if (!serverName || !toolName) {
                return null;
            }
            return `mcp__${serverName}__${toolName}`;
        };

        const isHapiChangeTitleToolName = (toolName: string | null): boolean => {
            return toolName === 'mcp__hapi__change_title';
        };

        const sendTitleSummary = (title: string): void => {
            session.client.sendClaudeSessionMessage({
                type: 'summary',
                summary: title,
                leafUuid: randomUUID()
            });
        };

        const formatOutputPreview = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value === null || value === undefined) return '';
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const compactText = (text: string): string => {
            return text.replace(/\s+/g, ' ').trim();
        };

        const truncateText = (text: string, maxLength: number): string => {
            const compacted = compactText(text);
            if (compacted.length <= maxLength) return compacted;
            return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
        };

        const previewText = (value: unknown, maxLength = 120): string | null => {
            const text = formatOutputPreview(value);
            const preview = truncateText(text, maxLength);
            return preview.length > 0 ? preview : null;
        };

        const formatActivity = (verb: string, detail?: string | null, maxLength = 120): string => {
            const normalizedDetail = detail ? truncateText(detail, maxLength) : '';
            return normalizedDetail ? `${verb}: ${normalizedDetail}` : verb;
        };

        const extractTextItems = (input: unknown): string[] => {
            const record = asRecord(input);
            if (!record || !Array.isArray(record.items)) return [];
            return record.items
                .map((item) => {
                    const itemRecord = asRecord(item);
                    return asString(itemRecord?.text);
                })
                .filter((text): text is string => Boolean(text));
        };

        const extractAgentPrompt = (input: unknown): string | null => {
            const record = asRecord(input);
            if (!record) return null;

            const direct = asString(record.message ?? record.prompt);
            if (direct) return direct;

            const textItems = extractTextItems(input);
            return textItems.length > 0 ? textItems.join('\n\n') : null;
        };

        const cleanAgentPromptForSummary = (prompt: string): string => {
            const withoutTags = prompt
                .replace(/<[^>\n]+>/g, ' ')
                .replace(/\r/g, '\n');
            const noisePatterns = [
                /not alone in the codebase/i,
                /do not revert/i,
                /don't revert/i,
                /list the file paths/i,
                /changed files/i,
                /final answer/i,
                /avoid merge conflicts/i,
                /accommodate the changes/i
            ];
            const lines = withoutTags
                .split('\n')
                .map((line) => line.trim().replace(/^[-*]\s+/, '').replace(/^#{1,6}\s+/, ''))
                .filter((line) => line.length > 0)
                .filter((line) => !noisePatterns.some((pattern) => pattern.test(line)));
            const candidate = lines.length > 0 ? lines.join(' ') : withoutTags;
            return compactText(candidate)
                .replace(/^(task|your task|request|prompt)\s*[:：]\s*/i, '')
                .trim();
        };

        const summarizeAgentInput = (input: unknown): string | null => {
            const prompt = extractAgentPrompt(input);
            if (prompt) {
                const cleaned = cleanAgentPromptForSummary(prompt);
                if (cleaned.length > 0) {
                    return truncateText(cleaned, 80);
                }
            }

            const record = asRecord(input);
            const agentType = asString(record?.agent_type ?? record?.subagent_type ?? record?.type);
            return agentType ? `${agentType} agent` : null;
        };

        const extractAgentType = (input: unknown): string | null => {
            const record = asRecord(input);
            if (!record) return null;
            return asString(record.agent_type ?? record.agentType ?? record.subagent_type ?? record.subagentType ?? record.type);
        };

        const getPatchFiles = (changes: unknown): string[] => {
            if (Array.isArray(changes)) {
                return changes.flatMap((change) => {
                    const record = asRecord(change);
                    const path = asString(record?.path ?? record?.file ?? record?.filePath ?? record?.file_path);
                    return path ? [path] : [];
                });
            }
            const record = asRecord(changes);
            if (!record) return [];
            const directPath = asString(record.path ?? record.file ?? record.filePath ?? record.file_path);
            if (directPath) return [directPath];
            return Object.keys(record).filter((file) => file.length > 0);
        };

        const summarizeFiles = (files: string[]): string | null => {
            if (files.length === 0) return null;
            const first = files[0] ?? '';
            const basename = first.split('/').filter(Boolean).pop() ?? first;
            return files.length > 1 ? `${basename} (+${files.length - 1})` : basename;
        };

        const summarizeDiffFiles = (diff: string): string | null => {
            const files: string[] = [];
            for (const line of diff.split('\n')) {
                if (!line.startsWith('+++ ')) continue;
                const file = line.replace(/^\+\+\+ (b\/)?/, '').trim();
                if (file && file !== '/dev/null') files.push(file);
            }
            return summarizeFiles([...new Set(files)]);
        };

        const displayMcpToolName = (toolName: string): string => {
            const match = toolName.match(/^mcp__(.+?)__(.+)$/);
            if (!match) return toolName;
            return `${match[1]}.${match[2]}`;
        };

        const getCurrentCodexPermissionMode = () => {
            const mode = session.getPermissionMode();
            return mode === 'default' || mode === 'read-only' || mode === 'safe-yolo' || mode === 'yolo'
                ? mode
                : undefined;
        };

        const permissionHandler = new CodexPermissionHandler(session.client, getCurrentCodexPermissionMode, {
            onRequest: ({ id, toolName, input }) => {
                if (toolName === 'request_user_input') {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'request_user_input',
                        callId: id,
                        input,
                        id: randomUUID()
                    });
                    return;
                }

                const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
                const message = typeof inputRecord.message === 'string' ? inputRecord.message : undefined;
                const rawCommand = inputRecord.command;
                const command = Array.isArray(rawCommand)
                    ? rawCommand.filter((part): part is string => typeof part === 'string').join(' ')
                    : typeof rawCommand === 'string'
                        ? rawCommand
                        : undefined;
                const cwdValue = inputRecord.cwd;
                const cwd = typeof cwdValue === 'string' && cwdValue.trim().length > 0 ? cwdValue : undefined;

                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'CodexPermission',
                    callId: id,
                    input: {
                        tool: toolName,
                        message,
                        command,
                        cwd
                    },
                    id: randomUUID()
                });
            },
            onComplete: ({ id, toolName, decision, reason, approved, answers }) => {
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: toolName === 'request_user_input'
                        ? { answers }
                        : {
                            decision,
                            reason
                        },
                    is_error: !approved,
                    id: randomUUID()
                });
                if (approved && isExitPlanModeTool(toolName)) {
                    session.setCollaborationMode('default');
                    logger.debug('[Codex] exit_plan_mode approved; collaborationMode reset to default');
                }
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const mcpTitleByCallId = new Map<string, string>();
        const toolStartedAtByCallId = new Map<string, number>();
        const agentCardByAgentId = new Map<string, string>();
        const agentSummaryByCardId = new Map<string, string>();
        const agentSummaryByAgentId = new Map<string, string>();
        const agentStatusByAgentId = new Map<string, string>();
        const agentStartedAtByCardId = new Map<string, number>();
        const agentStartedAtByAgentId = new Map<string, number>();
        const agentTypeByCardId = new Map<string, string>();
        const agentTypeByAgentId = new Map<string, string>();
        const pendingAgentStartCardIds = new Set<string>();
        const pendingAgentUpdatesByAgentId = new Map<string, Record<string, unknown>[]>();
        const pendingAgentTracesByAgentId = new Map<string, unknown[]>();
        const pendingAgentToolInputByCallId = new Map<string, { name: string; input: unknown }>();
        const childAgentRuntimeById = new Map<string, ChildAgentRuntime>();
        const childAgentConfigurationById = new Map<string, CodexSubagentConfiguration>();
        const subagentSnapshotById = new Map<string, CodexSubagentSnapshot>();
        const lastAgentRunUpdateAtByAgentId = new Map<string, number>();
        const lastAgentRunUpdateSignatureByAgentId = new Map<string, string>();
        const pendingThrottledAgentUpdateByAgentId = new Map<string, {
            update: Record<string, unknown>;
            cardIdOverride?: string | null;
        }>();
        const pendingThrottledAgentUpdateTimerByAgentId = new Map<string, ReturnType<typeof setTimeout>>();
        const pendingAgentStartTimersByCardId = new Map<string, ReturnType<typeof setTimeout>>();
        let subagentStateFlushTimer: ReturnType<typeof setTimeout> | null = null;
        let pendingSideSessionFork: PendingSideSessionFork | null = null;
        const takePendingSideSessionFork = (parentThreadId?: string): PendingSideSessionFork | null => {
            const fork = pendingSideSessionFork as PendingSideSessionFork | null;
            if (!fork) {
                return null;
            }
            if (parentThreadId && fork.parentThreadId !== parentThreadId) {
                return null;
            }
            pendingSideSessionFork = null;
            clearTimeout(fork.timeout);
            return fork;
        };
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;
        let readyAfterTurnTimer: ReturnType<typeof setTimeout> | null = null;
        let scheduleReadyAfterTurn: (() => void) | null = null;
        let clearReadyAfterTurnTimer: (() => void) | null = null;
        let turnInFlight = false;
        let allowAnonymousTerminalEvent = false;
        let invalidThreadId: string | null = null;
        let childAgentActivityInCurrentTurn = false;

        const isCodexAgentToolName = (toolName: string | null): boolean => {
            return toolName === 'spawn_agent'
                || toolName === 'send_input'
                || toolName === 'resume_agent'
                || toolName === 'wait_agent'
                || toolName === 'close_agent';
        };

        const isTerminalAgentRunStatus = (status: string | null | undefined): boolean => {
            return status === 'completed'
                || status === 'failed'
                || status === 'error'
                || status === 'canceled'
                || status === 'cancelled'
                || status === 'notFound'
                || status === 'not_found';
        };

        const flushSubagentState = (): void => {
            if (subagentStateFlushTimer) {
                clearTimeout(subagentStateFlushTimer);
                subagentStateFlushTimer = null;
            }
            if (subagentSnapshotById.size === 0) {
                return;
            }

            const subagents = Object.fromEntries(
                Array.from(subagentSnapshotById.entries()).map(([agentId, snapshot]) => [agentId, { ...snapshot }])
            );
            const activeSubagentId = Array.from(subagentSnapshotById.values())
                .filter((snapshot) => !isTerminalAgentRunStatus(snapshot.status))
                .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
            const updatedAt = Date.now();
            const updateAgentState = (session as unknown as {
                updateAgentState?: CodexSession['updateAgentState'];
            }).updateAgentState;
            if (!updateAgentState) {
                return;
            }

            updateAgentState.call(session, (state) => ({
                ...state,
                codex: {
                    ...(state.codex ?? {}),
                    activeSubagentId,
                    subagents,
                    updatedAt
                }
            }));
        };

        const scheduleSubagentStateFlush = (immediate = false): void => {
            if (immediate) {
                flushSubagentState();
                return;
            }
            if (subagentStateFlushTimer) return;
            subagentStateFlushTimer = setTimeout(flushSubagentState, SUBAGENT_STATE_FLUSH_DEBOUNCE_MS);
            subagentStateFlushTimer.unref?.();
        };

        const upsertSubagentSnapshot = (
            agentId: string,
            event: Record<string, unknown>,
            flushImmediately: boolean
        ): void => {
            const now = Date.now();
            const existing = subagentSnapshotById.get(agentId);
            const status = asString(event.status) ?? existing?.status ?? 'running';
            const cardId = asString(event.cardId ?? event.card_id) ?? existing?.cardId ?? agentCardByAgentId.get(agentId);
            const startedAt = typeof event.startedAt === 'number'
                ? event.startedAt
                : existing?.startedAt ?? agentStartedAtByAgentId.get(agentId) ?? now;
            const completedAt = typeof event.completedAt === 'number'
                ? event.completedAt
                : existing?.completedAt;
            const summary = asString(event.summary) ?? existing?.summary ?? agentSummaryByAgentId.get(agentId);
            const type = existing?.type ?? agentTypeByAgentId.get(agentId);
            const statusText = asString(event.statusText ?? event.status_text) ?? existing?.statusText;
            const activity = asString(event.activity) ?? existing?.activity;
            const activityKind = asString(event.activityKind ?? event.activity_kind) ?? existing?.activityKind;
            const threadId = asString(event.threadId ?? event.thread_id) ?? existing?.threadId ?? agentId;
            const turnId = asString(event.turnId ?? event.turn_id) ?? existing?.turnId ?? this.activeChildTurns.get(threadId);

            subagentSnapshotById.set(agentId, {
                id: agentId,
                ...(cardId ? { cardId } : {}),
                ...(threadId ? { threadId } : {}),
                ...(turnId ? { turnId } : {}),
                ...(type ? { type } : {}),
                ...(summary ? { title: summary, summary } : {}),
                status,
                ...(statusText ? { statusText } : {}),
                ...(activity ? { activity } : {}),
                ...(activityKind ? { activityKind } : {}),
                startedAt,
                updatedAt: now,
                ...(completedAt ? { completedAt } : {})
            });

            scheduleSubagentStateFlush(flushImmediately);
        };

        const markAllActiveSubagents = (status: string, statusText: string): void => {
            for (const snapshot of subagentSnapshotById.values()) {
                if (isTerminalAgentRunStatus(snapshot.status)) continue;
                subagentSnapshotById.set(snapshot.id, {
                    ...snapshot,
                    status,
                    statusText,
                    activity: statusText,
                    activityKind: status,
                    updatedAt: Date.now(),
                    completedAt: Date.now()
                });
            }
            flushSubagentState();
        };

        const isCloseAgentCleanupUpdate = (update: Record<string, unknown>): boolean => {
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (activityKind === 'close_agent' || activityKind === 'closed') return true;
            return activityKind === 'canceled'
                && (asString(update.activity) === 'Closed' || asString(update.statusText ?? update.status_text) === 'Closed');
        };

        const isScopeSensitiveCodexEvent = (type: string): boolean => {
            return type === 'token_count'
                || type === 'context_compacted'
                || type === 'thread_goal_updated'
                || type === 'thread_goal_cleared';
        };

        const hasKnownChildAgents = (): boolean => {
            if (childAgentActivityInCurrentTurn) return true;
            if (pendingAgentStartCardIds.size > 0) return true;
            for (const agentId of new Set([...agentCardByAgentId.keys(), ...childAgentRuntimeById.keys()])) {
                const status = agentStatusByAgentId.get(agentId);
                if (!isTerminalAgentRunStatus(status)) {
                    return true;
                }
            }
            return false;
        };

        const buildCodexEventScope = (
            threadId: string | null,
            role: 'parent' | 'child',
            agentId?: string | null
        ): Record<string, unknown> => ({
            role,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            ...(this.currentThreadId ? { parentThreadId: this.currentThreadId, parent_thread_id: this.currentThreadId } : {}),
            ...(agentId ? { agentId, agent_id: agentId } : {})
        });

        const addCodexEventScope = (
            event: Record<string, unknown>,
            role: 'parent' | 'child',
            threadId: string | null,
            agentId?: string | null
        ): Record<string, unknown> => ({
            ...event,
            ...(threadId ? { threadId, thread_id: threadId } : {}),
            scopeRole: role,
            scope_role: role,
            scope: buildCodexEventScope(threadId, role, agentId)
        });

        const extractAgentTargets = (input: unknown): string[] => {
            const record = asRecord(input);
            if (!record) return [];
            const targets = Array.isArray(record.targets)
                ? record.targets.filter((target): target is string => typeof target === 'string' && target.length > 0)
                : [];
            if (targets.length > 0) return targets;
            return [record.target, record.agent_id, record.agentId, record.id]
                .filter((target): target is string => typeof target === 'string' && target.length > 0);
        };

        const emitAgentRunEvent = (event: Record<string, unknown>): void => {
            const agentId = asString(event.agentId ?? event.agent_id);
            session.sendAgentMessage({
                ...(agentId ? addCodexEventScope(event, 'child', agentId, agentId) : event),
                id: randomUUID()
            });
        };

        const clearPendingAgentStart = (cardId: string): void => {
            const timer = pendingAgentStartTimersByCardId.get(cardId);
            if (timer) {
                clearTimeout(timer);
            }
            pendingAgentStartTimersByCardId.delete(cardId);
            pendingAgentStartCardIds.delete(cardId);
        };

        let failAgentStartCard = (_cardId: string, _error: unknown): void => {};

        const getParentSubagentConfiguration = (): Record<string, string> => {
            const parentModel = asString(session.getModel());
            const parentReasoningEffort = asString(session.getModelReasoningEffort());
            return {
                ...(parentModel ? { parentModel } : {}),
                ...(parentReasoningEffort ? { parentReasoningEffort } : {})
            };
        };

        const addParentSubagentConfiguration = (input: unknown): unknown => {
            const record = asRecord(input);
            const parentConfiguration = getParentSubagentConfiguration();
            if (!record || Object.keys(parentConfiguration).length === 0) {
                return input;
            }

            const existingConfiguration = asRecord(record.hapiSubagentConfig) ?? {};
            return {
                ...record,
                hapiSubagentConfig: {
                    ...existingConfiguration,
                    ...parentConfiguration
                }
            };
        };

        const emitAgentRunStart = (cardId: string, input: unknown): void => {
            childAgentActivityInCurrentTurn = true;
            const startedAt = Date.now();
            const cardInput = addParentSubagentConfiguration(input);
            agentStartedAtByCardId.set(cardId, startedAt);
            const agentType = extractAgentType(cardInput);
            if (agentType) {
                agentTypeByCardId.set(cardId, agentType);
            }
            const summary = summarizeAgentInput(cardInput);
            if (summary) {
                agentSummaryByCardId.set(cardId, summary);
            }
            clearPendingAgentStart(cardId);
            pendingAgentStartCardIds.add(cardId);
            const timer = setTimeout(() => {
                failAgentStartCard(
                    cardId,
                    `spawn_agent did not return an agent id within ${AGENT_RUN_START_TIMEOUT_MS / 1000}s`
                );
            }, AGENT_RUN_START_TIMEOUT_MS);
            timer.unref?.();
            pendingAgentStartTimersByCardId.set(cardId, timer);
            emitAgentRunEvent({
                type: 'agent-run-start',
                cardId,
                input: cardInput,
                startedAt,
                status: 'starting',
                statusText: 'Starting',
                activity: 'Starting',
                activityKind: 'starting',
                ...(summary ? { summary } : {})
            });
        };

        const flushPendingAgentTraces = (agentId: string): void => {
            const traces = pendingAgentTracesByAgentId.get(agentId);
            if (!traces || traces.length === 0) return;
            pendingAgentTracesByAgentId.delete(agentId);
            for (const message of traces) {
                emitAgentRunEvent({
                    type: 'agent-run-trace',
                    agentId,
                    cardId: agentCardByAgentId.get(agentId),
                    ...(agentStartedAtByAgentId.has(agentId) ? { startedAt: agentStartedAtByAgentId.get(agentId) } : {}),
                    message
                });
            }
        };

        const linkAgentToCard = (agentId: string, cardId: string): void => {
            agentCardByAgentId.set(agentId, cardId);
            clearPendingAgentStart(cardId);
            const startedAt = agentStartedAtByCardId.get(cardId) ?? agentStartedAtByAgentId.get(agentId);
            if (startedAt) {
                agentStartedAtByCardId.set(cardId, startedAt);
                agentStartedAtByAgentId.set(agentId, startedAt);
            }
            const summary = agentSummaryByCardId.get(cardId);
            if (summary) {
                agentSummaryByAgentId.set(agentId, summary);
            }
            const agentType = agentTypeByCardId.get(cardId);
            if (agentType) {
                agentTypeByAgentId.set(agentId, agentType);
            }
            upsertSubagentSnapshot(agentId, {
                status: agentStatusByAgentId.get(agentId) ?? 'starting',
                statusText: 'Starting',
                activity: 'Starting',
                activityKind: 'starting',
                cardId,
                startedAt,
                ...(summary ? { summary } : {})
            }, false);
            flushPendingAgentTraces(agentId);
        };

        const getOnlyPendingAgentStartCardId = (): string | null => {
            if (pendingAgentStartCardIds.size !== 1) return null;
            return pendingAgentStartCardIds.values().next().value ?? null;
        };

        const linkPendingAgentStartFromChildTask = (agentId: string): void => {
            if (agentCardByAgentId.has(agentId)) {
                return;
            }

            const cardId = getOnlyPendingAgentStartCardId();
            if (!cardId) {
                if (pendingAgentStartCardIds.size > 1) {
                    logger.debug(
                        `[Codex] Child task_started while ${pendingAgentStartCardIds.size} spawn_agent cards are pending; ` +
                        `not linking automatically; agentId=${agentId}`
                    );
                }
                return;
            }

            logger.debug(`[Codex] Linking pending spawn_agent card from child task_started; cardId=${cardId}, agentId=${agentId}`);
            linkAgentToCard(agentId, cardId);
            emitAgentRunUpdate(agentId, {
                status: 'running',
                statusText: 'Running',
                activity: 'Started',
                activityKind: 'running'
            }, cardId);
            flushPendingAgentUpdates(agentId);
        };

        const flushPendingAgentUpdates = (agentId: string): void => {
            const updates = pendingAgentUpdatesByAgentId.get(agentId);
            if (!updates || updates.length === 0) return;
            pendingAgentUpdatesByAgentId.delete(agentId);
            for (const update of updates) {
                emitAgentRunUpdate(agentId, update);
            }
        };

        const stableStringify = (value: unknown): string => {
            if (value === null || typeof value !== 'object') {
                return JSON.stringify(value);
            }
            if (Array.isArray(value)) {
                return `[${value.map(stableStringify).join(',')}]`;
            }
            const record = value as Record<string, unknown>;
            return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
        };

        const getAgentRunUpdateSignature = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): string => stableStringify({
            agentId,
            cardIdOverride: cardIdOverride ?? null,
            update
        });

        const cancelPendingThrottledAgentRunUpdate = (agentId: string): void => {
            const timer = pendingThrottledAgentUpdateTimerByAgentId.get(agentId);
            if (timer) {
                clearTimeout(timer);
            }
            pendingThrottledAgentUpdateTimerByAgentId.delete(agentId);
            pendingThrottledAgentUpdateByAgentId.delete(agentId);
        };

        const cancelAllPendingThrottledAgentRunUpdates = (): void => {
            for (const agentId of Array.from(pendingThrottledAgentUpdateTimerByAgentId.keys())) {
                cancelPendingThrottledAgentRunUpdate(agentId);
            }
            pendingThrottledAgentUpdateByAgentId.clear();
        };

        const flushPendingThrottledAgentRunUpdate = (agentId: string): void => {
            const pendingUpdate = pendingThrottledAgentUpdateByAgentId.get(agentId);
            pendingThrottledAgentUpdateTimerByAgentId.delete(agentId);
            pendingThrottledAgentUpdateByAgentId.delete(agentId);
            if (!pendingUpdate) return;
            emitAgentRunUpdateNow(agentId, pendingUpdate.update, pendingUpdate.cardIdOverride);
        };

        const scheduleThrottledAgentRunUpdate = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            pendingThrottledAgentUpdateByAgentId.set(agentId, { update, cardIdOverride });
            if (pendingThrottledAgentUpdateTimerByAgentId.has(agentId)) {
                return;
            }

            const lastAt = lastAgentRunUpdateAtByAgentId.get(agentId) ?? 0;
            const delay = Math.max(AGENT_RUN_UPDATE_THROTTLE_MS - (Date.now() - lastAt), 0);
            const timer = setTimeout(() => {
                flushPendingThrottledAgentRunUpdate(agentId);
            }, delay);
            timer.unref?.();
            pendingThrottledAgentUpdateTimerByAgentId.set(agentId, timer);
        };

        const emitAgentRunUpdateNow = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            const knownCardId = agentCardByAgentId.get(agentId);
            if (
                !cardIdOverride
                && !knownCardId
                && pendingAgentStartCardIds.size > 0
                && childAgentRuntimeById.has(agentId)
            ) {
                const updates = pendingAgentUpdatesByAgentId.get(agentId) ?? [];
                updates.push(update);
                pendingAgentUpdatesByAgentId.set(agentId, updates);
                return;
            }

            const cardId = cardIdOverride ?? knownCardId ?? `codex-agent:${agentId}`;
            if (!knownCardId) {
                agentCardByAgentId.set(agentId, cardId);
            }
            const startedAt = agentStartedAtByAgentId.get(agentId)
                ?? agentStartedAtByCardId.get(cardId)
                ?? Date.now();
            agentStartedAtByAgentId.set(agentId, startedAt);
            agentStartedAtByCardId.set(cardId, startedAt);
            const nextStatus = asString(update.status);
            const currentStatus = agentStatusByAgentId.get(agentId);
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (
                isTerminalAgentRunStatus(currentStatus)
                && !isTerminalAgentRunStatus(nextStatus)
                && activityKind !== 'send_input'
                && activityKind !== 'resume_agent'
            ) {
                return;
            }
            if (
                childAgentRuntimeById.get(agentId)?.blockedNestedAgent
                && nextStatus !== 'failed'
                && nextStatus !== 'error'
            ) {
                return;
            }
            if (
                isTerminalAgentRunStatus(currentStatus)
                && nextStatus !== 'failed'
                && nextStatus !== 'error'
                && isCloseAgentCleanupUpdate(update)
            ) {
                return;
            }
            const nextSummary = asString(update.summary);
            if (nextSummary) {
                agentSummaryByAgentId.set(agentId, nextSummary);
                agentSummaryByCardId.set(cardId, nextSummary);
            }
            if (nextStatus) {
                agentStatusByAgentId.set(agentId, nextStatus);
            }
            const hapiSubagentConfig = {
                ...(asRecord(update.hapiSubagentConfig) ?? {}),
                ...(childAgentConfigurationById.get(agentId) ?? {})
            };
            const event = {
                type: 'agent-run-update',
                agentId,
                cardId,
                startedAt,
                ...(isTerminalAgentRunStatus(nextStatus) ? { completedAt: Date.now() } : {}),
                ...(agentSummaryByAgentId.has(agentId) ? { summary: agentSummaryByAgentId.get(agentId) } : {}),
                ...update,
                ...(Object.keys(hapiSubagentConfig).length > 0 ? { hapiSubagentConfig } : {})
            };
            const signature = getAgentRunUpdateSignature(agentId, event, cardIdOverride);
            if (lastAgentRunUpdateSignatureByAgentId.get(agentId) === signature) {
                return;
            }
            lastAgentRunUpdateSignatureByAgentId.set(agentId, signature);
            lastAgentRunUpdateAtByAgentId.set(agentId, Date.now());
            upsertSubagentSnapshot(agentId, event, isTerminalAgentRunStatus(nextStatus));
            emitAgentRunEvent(event);
            flushPendingAgentTraces(agentId);
        };

        const emitAgentRunUpdate = (
            agentId: string,
            update: Record<string, unknown>,
            cardIdOverride?: string | null
        ): void => {
            const nextStatus = asString(update.status);
            const terminal = isTerminalAgentRunStatus(nextStatus);
            if (terminal) {
                cancelPendingThrottledAgentRunUpdate(agentId);
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            const activityKind = asString(update.activityKind ?? update.activity_kind);
            if (!activityKind || !THROTTLED_AGENT_RUN_ACTIVITY_KINDS.has(activityKind)) {
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            const lastAt = lastAgentRunUpdateAtByAgentId.get(agentId);
            if (lastAt === undefined || Date.now() - lastAt >= AGENT_RUN_UPDATE_THROTTLE_MS) {
                emitAgentRunUpdateNow(agentId, update, cardIdOverride);
                return;
            }

            scheduleThrottledAgentRunUpdate(agentId, update, cardIdOverride);
        };

        const getFirstChildConfigurationValue = (
            records: Array<Record<string, unknown> | null>,
            keys: string[]
        ): string | null => {
            for (const record of records) {
                if (!record) continue;
                for (const key of keys) {
                    const value = asString(record[key]);
                    if (value) return value;
                }
            }
            return null;
        };

        const extractChildAgentConfiguration = (event: Record<string, unknown>): CodexSubagentConfiguration => {
            const turn = asRecord(event.turn);
            const thread = asRecord(event.thread);
            const records = [
                event,
                turn,
                thread,
                asRecord(event.config),
                asRecord(event.configuration),
                asRecord(event.turnContext),
                asRecord(event.turn_context),
                asRecord(turn?.config),
                asRecord(turn?.configuration),
                asRecord(thread?.config),
                asRecord(thread?.configuration)
            ];
            const childModel = getFirstChildConfigurationValue(records, ['model', 'modelId', 'model_id']);
            const childReasoningEffort = getFirstChildConfigurationValue(records, [
                'reasoningEffort',
                'reasoning_effort',
                'modelReasoningEffort',
                'model_reasoning_effort'
            ]);
            return {
                ...(childModel ? { childModel } : {}),
                ...(childReasoningEffort ? { childReasoningEffort } : {})
            };
        };

        const captureChildAgentConfiguration = (agentId: string, event: Record<string, unknown>): void => {
            const nextValues = extractChildAgentConfiguration(event);
            if (Object.keys(nextValues).length === 0) return;

            const previous = childAgentConfigurationById.get(agentId) ?? {};
            const next = { ...previous, ...nextValues };
            if (
                next.childModel === previous.childModel
                && next.childReasoningEffort === previous.childReasoningEffort
            ) {
                return;
            }
            childAgentConfigurationById.set(agentId, next);

            const cardId = agentCardByAgentId.get(agentId);
            if (!cardId) return;

            const snapshot = subagentSnapshotById.get(agentId);
            const status = snapshot?.status ?? agentStatusByAgentId.get(agentId) ?? 'running';
            emitAgentRunUpdate(agentId, {
                status,
                statusText: snapshot?.statusText ?? status
            }, cardId);
        };

        failAgentStartCard = (cardId: string, error: unknown): void => {
            if (!pendingAgentStartCardIds.has(cardId) && !pendingAgentStartTimersByCardId.has(cardId)) {
                return;
            }

            const agentId = `spawn-error:${cardId}`;
            linkAgentToCard(agentId, cardId);
            emitAgentRunUpdate(agentId, {
                status: 'failed',
                statusText: 'Failed to start',
                activity: formatActivity('Failed to start', previewText(error)),
                activityKind: 'failed',
                error
            }, cardId);
        };

        const failPendingAgentStarts = (error: unknown): void => {
            for (const cardId of Array.from(pendingAgentStartCardIds)) {
                failAgentStartCard(cardId, error);
            }
        };

        const isPresentSpawnOption = (value: unknown): boolean => {
            if (value === undefined || value === null) return false;
            return typeof value !== 'string' || value.trim().length > 0;
        };

        const isFullHistorySpawnWithInheritedOverrides = (input: unknown): boolean => {
            const record = asRecord(input);
            if (!record) return false;

            const forkContext = record.fork_context ?? record.forkContext;
            if (forkContext === false) {
                return false;
            }

            return [
                record.agent_type,
                record.agentType,
                record.subagent_type,
                record.subagentType,
                record.model,
                record.reasoning_effort,
                record.reasoningEffort
            ].some(isPresentSpawnOption);
        };

        const failPendingAgentStartsForSpawnArgumentError = (error: unknown): void => {
            const matchingCardIds = Array.from(pendingAgentStartCardIds).filter((cardId) => {
                return isFullHistorySpawnWithInheritedOverrides(
                    pendingAgentToolInputByCallId.get(cardId)?.input
                );
            });

            if (matchingCardIds.length > 0) {
                for (const cardId of matchingCardIds) {
                    failAgentStartCard(cardId, error);
                }
                return;
            }

            if (pendingAgentStartCardIds.size === 1) {
                failPendingAgentStarts(error);
                return;
            }

            logger.debug(
                `[Codex] Ignoring spawn_agent argument stderr error for ${pendingAgentStartCardIds.size} ` +
                'pending starts because none have detectable inherited-override args'
            );
        };

        const emitAgentRunTraceMessage = (agentId: string, message: unknown): void => {
            const cardId = agentCardByAgentId.get(agentId);
            if (!cardId) {
                const traces = pendingAgentTracesByAgentId.get(agentId) ?? [];
                traces.push(message);
                pendingAgentTracesByAgentId.set(agentId, traces);
                return;
            }
            emitAgentRunEvent({
                type: 'agent-run-trace',
                agentId,
                cardId,
                ...(agentStartedAtByAgentId.has(agentId) ? { startedAt: agentStartedAtByAgentId.get(agentId) } : {}),
                message
            });
        };

        const getChildRuntime = (agentId: string) => {
            const existing = childAgentRuntimeById.get(agentId);
            if (existing) return existing;
            const runtime = {
                reasoningProcessor: new ReasoningProcessor((message) => {
                    emitAgentRunTraceMessage(agentId, message);
                }),
                diffProcessor: new DiffProcessor((message) => {
                    emitAgentRunTraceMessage(agentId, message);
                }),
                toolStartedAtByCallId: new Map(),
                activeToolsByCallId: new Map(),
                pendingTitleByCallId: new Map(),
                reasoningPreview: '',
                finalMessage: null,
                terminal: false,
                blockedNestedAgent: false
            };
            childAgentRuntimeById.set(agentId, runtime);
            return runtime;
        };

        const extractAgentStatusMessage = (record: Record<string, unknown>): unknown => {
            const message = asString(record.message);
            if (message) return message;

            for (const key of ['output', 'result', 'finalMessage', 'final_message'] as const) {
                const value = record[key];
                if (value !== undefined && value !== null) {
                    return asString(value) ?? value;
                }
            }

            return undefined;
        };

        const normalizeAgentStateValue = (value: unknown): string | null => {
            return asString(value)?.trim().toLowerCase().replace(/[\s_-]/g, '') ?? null;
        };

        const hasOwn = (record: Record<string, unknown>, key: string): boolean => {
            return Object.prototype.hasOwnProperty.call(record, key);
        };

        const fillCompletedAgentUpdateFromRuntime = (
            agentId: string,
            update: Record<string, unknown>
        ): Record<string, unknown> => {
            if (asString(update.status) !== 'completed') return update;
            if (hasOwn(update, 'result') || hasOwn(update, 'error')) return update;

            const result = childAgentRuntimeById.get(agentId)?.finalMessage;
            if (!result) return update;

            return {
                ...update,
                activity: formatActivity('Completed', result),
                result
            };
        };

        const normalizeAgentStatusUpdate = (value: unknown): Record<string, unknown> => {
            if (typeof value === 'string') {
                const normalized = normalizeAgentStateValue(value);
                if (normalized === 'completed' || normalized === 'complete' || normalized === 'done') {
                    return {
                        status: 'completed',
                        statusText: 'Completed',
                        activity: 'Completed',
                        activityKind: 'completed'
                    };
                }
                const activity = formatActivity('Completed', previewText(value));
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity,
                    activityKind: 'completed',
                    result: value
                };
            }

            const record = asRecord(value);
            if (!record) {
                const activity = formatActivity('Completed', previewText(value));
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity,
                    activityKind: 'completed',
                    result: value
                };
            }

            const completed = asString(record.completed);
            if (completed) {
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity: formatActivity('Completed', completed),
                    activityKind: 'completed',
                    result: completed
                };
            }
            const done = asString(record.done);
            if (done) {
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity: formatActivity('Completed', done),
                    activityKind: 'completed',
                    result: done
                };
            }
            const failed = asString(record.failed ?? record.error);
            if (failed) {
                return {
                    status: 'failed',
                    statusText: 'Failed',
                    activity: formatActivity('Failed', failed),
                    activityKind: 'failed',
                    error: failed
                };
            }
            const canceled = asString(record.canceled ?? record.cancelled);
            if (canceled) {
                return {
                    status: 'canceled',
                    statusText: 'Canceled',
                    activity: formatActivity('Canceled', canceled),
                    activityKind: 'canceled',
                    error: canceled
                };
            }

            const rawStatus = asString(record.status ?? record.state);
            const normalizedStatus = normalizeAgentStateValue(record.status ?? record.state);
            if (normalizedStatus === 'notfound') {
                const error = record.message ?? record.error ?? value;
                return {
                    status: 'failed',
                    statusText: 'Not found',
                    activity: formatActivity('Agent not found', previewText(error)),
                    activityKind: 'not_found',
                    error
                };
            }
            if (
                normalizedStatus === 'completed'
                || normalizedStatus === 'complete'
                || normalizedStatus === 'done'
                || record.completed === true
                || record.done === true
            ) {
                const result = extractAgentStatusMessage(record);
                return {
                    status: 'completed',
                    statusText: 'Completed',
                    activity: formatActivity('Completed', previewText(result)),
                    activityKind: 'completed',
                    ...(result !== undefined && result !== null ? { result } : {})
                };
            }
            if (normalizedStatus === 'failed' || normalizedStatus === 'error') {
                const error = extractAgentStatusMessage(record) ?? record.error ?? value;
                return {
                    status: 'failed',
                    statusText: 'Failed',
                    activity: formatActivity('Failed', previewText(error)),
                    activityKind: 'failed',
                    error
                };
            }
            if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled') {
                const error = extractAgentStatusMessage(record) ?? record.error ?? value;
                return {
                    status: 'canceled',
                    statusText: 'Canceled',
                    activity: formatActivity('Canceled', previewText(error)),
                    activityKind: 'canceled',
                    error
                };
            }

            return {
                status: rawStatus ?? 'running',
                statusText: rawStatus ?? 'Running',
                activity: formatActivity(rawStatus ?? 'Running', previewText(extractAgentStatusMessage(record) ?? value)),
                activityKind: rawStatus ?? 'running',
                result: value
            };
        };

        const isAgentNotFoundStatusUpdate = (update: Record<string, unknown>): boolean => {
            const status = asString(update.status);
            const activityKind = asString(update.activityKind ?? update.activity_kind);
            return status === 'notFound'
                || status === 'not_found'
                || activityKind === 'not_found';
        };

        const handleAgentToolEnd = (callId: string, name: string, output: unknown, isError: boolean): void => {
            const pending = pendingAgentToolInputByCallId.get(callId);
            pendingAgentToolInputByCallId.delete(callId);

            if (name === 'spawn_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const agentsStates = asRecord(outputRecord?.agentsStates ?? outputRecord?.agents_states);
                const agentIdsFromState = agentsStates ? Object.keys(agentsStates) : [];
                const agentId = asString(outputRecord?.agent_id ?? outputRecord?.agentId ?? outputRecord?.id)
                    ?? (agentIdsFromState.length === 1 ? agentIdsFromState[0] : null)
                    ?? extractAgentTargets(pending?.input).at(0);
                const sideSessionFork = pendingSideSessionFork
                    && (pendingSideSessionFork.callId === null || pendingSideSessionFork.callId === callId)
                    ? pendingSideSessionFork
                    : null;
                if (!agentId) {
                    const detail = isError
                        ? output
                        : {
                            message: 'spawn_agent completed without returning an agent id',
                            output
                        };
                    if (sideSessionFork) {
                        pendingSideSessionFork = null;
                        clearTimeout(sideSessionFork.timeout);
                        sideSessionFork.reject(new Error(previewText(detail) ?? 'spawn_agent completed without returning an agent id'));
                    }
                    failAgentStartCard(callId, detail);
                    return;
                }
                linkAgentToCard(agentId, callId);
                emitAgentRunUpdate(agentId, {
                    status: isError ? 'failed' : 'running',
                    statusText: isError ? 'Failed to start' : 'Running',
                    activity: isError ? formatActivity('Failed to start', previewText(output)) : 'Started',
                    activityKind: isError ? 'failed' : 'running',
                    ...(isError ? { error: output } : { spawnResult: output })
                }, callId);
                flushPendingAgentUpdates(agentId);
                if (sideSessionFork) {
                    pendingSideSessionFork = null;
                    clearTimeout(sideSessionFork.timeout);
                    if (isError) {
                        sideSessionFork.reject(new Error(previewText(output) ?? 'spawn_agent failed'));
                    } else {
                        sideSessionFork.resolve({
                            childCodexThreadId: agentId,
                            parentCodexThreadId: sideSessionFork.parentThreadId
                        });
                    }
                }
                return;
            }

            if (name === 'wait_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const statusMap = asRecord(outputRecord?.status) ?? {};
                for (const [agentId, statusValue] of Object.entries(statusMap)) {
                    const update = fillCompletedAgentUpdateFromRuntime(
                        agentId,
                        normalizeAgentStatusUpdate(statusValue)
                    );
                    if (!agentCardByAgentId.has(agentId) && isAgentNotFoundStatusUpdate(update)) {
                        continue;
                    }
                    if (asString(update.status) === 'completed') {
                        const runtime = childAgentRuntimeById.get(agentId);
                        if (runtime) {
                            runtime.terminal = true;
                        }
                    }
                    emitAgentRunUpdate(agentId, update);
                }
                return;
            }

            if (name === 'send_input' || name === 'resume_agent') {
                childAgentActivityInCurrentTurn = true;
                const outputRecord = asRecord(output);
                const targets = Array.from(new Set([
                    ...extractAgentTargets(pending?.input),
                    ...extractAgentTargets(outputRecord)
                ]));
                const label = name === 'send_input' ? 'Send input' : 'Resume';
                const successActivity = name === 'send_input' ? 'Input sent' : 'Resumed';
                const errorDetail = asString(outputRecord?.error ?? outputRecord?.message) ?? output;

                for (const agentId of targets) {
                    if (!agentCardByAgentId.has(agentId)) continue;
                    emitAgentRunUpdate(agentId, {
                        status: isError ? 'failed' : 'running',
                        statusText: isError ? `${label} failed` : successActivity,
                        activity: isError ? formatActivity(`${label} failed`, previewText(errorDetail)) : successActivity,
                        activityKind: isError ? 'failed' : name,
                        ...(isError ? { error: output } : { result: output })
                    });
                }
                return;
            }

            if (name === 'close_agent') {
                const outputRecord = asRecord(output);
                const agentId = asString(outputRecord?.agent_id ?? outputRecord?.agentId)
                    ?? extractAgentTargets(pending?.input).at(0);
                if (!agentId) return;
                emitAgentRunUpdate(agentId, {
                    status: isError ? 'failed' : 'completed',
                    statusText: isError ? 'Close failed' : 'Closed',
                    activity: isError ? formatActivity('Close failed', previewText(output)) : 'Closed',
                    activityKind: isError ? 'failed' : 'closed',
                    ...(isError ? { error: output } : { result: output })
                });
                return;
            }
        };

        const handleChildCodexEvent = (agentId: string, msg: Record<string, unknown>): void => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            childAgentActivityInCurrentTurn = true;
            const runtime = getChildRuntime(agentId);
            const isChildTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';
            if (runtime.blockedNestedAgent && !isChildTerminalEvent) {
                return;
            }
            const updateActivity = (
                activity: string,
                activityKind: string,
                extra?: Record<string, unknown>
            ): void => {
                if (runtime.terminal) {
                    return;
                }
                emitAgentRunUpdate(agentId, {
                    status: 'running',
                    statusText: activity,
                    activity,
                    activityKind,
                    ...extra
                });
            };

            if (msgType === 'token_count') {
                return;
            }

            if (msgType === 'context_compacted') {
                emitAgentRunTraceMessage(agentId, {
                    type: 'context_compacted',
                    id: randomUUID()
                });
                updateActivity('Context compacted', 'compact');
                return;
            }

            if (msgType === 'task_started') {
                runtime.reasoningPreview = '';
                runtime.finalMessage = null;
                runtime.terminal = false;
                agentStatusByAgentId.delete(agentId);
                updateActivity('Starting task', 'starting');
                return;
            }
            if (msgType === 'agent_reasoning_section_break') {
                runtime.reasoningProcessor.handleSectionBreak();
                runtime.reasoningPreview = '';
                updateActivity('Thinking', 'thinking');
                return;
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    runtime.reasoningProcessor.processDelta(delta);
                    runtime.reasoningPreview = truncateText(`${runtime.reasoningPreview}${delta}`, 160);
                }
                updateActivity(formatActivity('Thinking', runtime.reasoningPreview || null), 'thinking');
                return;
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    runtime.reasoningProcessor.complete(text);
                    runtime.reasoningPreview = truncateText(text, 160);
                }
                updateActivity(formatActivity('Thinking', runtime.reasoningPreview || null), 'thinking');
                return;
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    runtime.finalMessage = message;
                    emitAgentRunTraceMessage(agentId, {
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
                if (runtime.terminal) {
                    if (message) {
                        emitAgentRunUpdate(agentId, {
                            status: 'completed',
                            statusText: 'Completed',
                            activity: formatActivity('Completed', message),
                            activityKind: 'completed',
                            result: message
                        });
                    }
                    return;
                }
                updateActivity(formatActivity('Writing', message), 'writing');
                return;
            }
            if (msgType === 'codex_session_event') {
                return;
            }
            if (msgType === 'agent_message_snapshot') {
                const message = asString(msg.message);
                if (message) {
                    updateActivity(formatActivity('Writing', message), 'writing');
                }
                return;
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const startedAt = beginToolTiming(runtime.toolStartedAtByCallId, callId);
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId,
                        input: inputs,
                        startedAt,
                        id: randomUUID()
                    });
                    const command = normalizeCommand(inputs.command) ?? 'command';
                    if (!runtime.terminal) {
                        runtime.activeToolsByCallId.set(callId, {
                            name: 'CodexBash',
                            label: command,
                            activity: formatActivity('Running command', command),
                            activityKind: 'running-command'
                        });
                        emitAgentRunUpdate(agentId, {
                            status: 'running',
                            statusText: formatActivity('Running command', command),
                            activity: formatActivity('Running command', command),
                            activityKind: 'running-command'
                        });
                    }
                }
                return;
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(runtime.toolStartedAtByCallId, callId);
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;
                    output.stdout = output.output;
                    delete output.output;
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: Boolean(output.error),
                        ...timing,
                        id: randomUUID()
                    });
                    const label = activeTool?.label ?? normalizeCommand(output.command) ?? 'command';
                    const isError = Boolean(output.error);
                    updateActivity(
                        formatActivity(isError ? 'Command failed' : 'Command finished', label),
                        isError ? 'command-failed' : 'command-completed'
                    );
                }
                return;
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const startedAt = beginToolTiming(runtime.toolStartedAtByCallId, callId);
                    const changes = msg.changes ?? {};
                    const files = getPatchFiles(changes);
                    const fileSummary = summarizeFiles(files);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        startedAt,
                        id: randomUUID()
                    });
                    runtime.activeToolsByCallId.set(callId, {
                        name: 'CodexPatch',
                        label: fileSummary ?? 'files',
                        activity: formatActivity('Editing files', fileSummary),
                        activityKind: 'editing'
                    });
                    updateActivity(formatActivity('Editing files', fileSummary), 'editing');
                }
                return;
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(runtime.toolStartedAtByCallId, callId);
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output: { stdout, stderr, success },
                        is_error: !success,
                        ...timing,
                        id: randomUUID()
                    });
                    updateActivity(
                        formatActivity(success ? 'Files edited' : 'Edit failed', activeTool?.label ?? previewText(stderr ?? stdout)),
                        success ? 'edited' : 'edit-failed'
                    );
                }
                return;
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    const startedAt = beginToolTiming(runtime.toolStartedAtByCallId, callId);
                    const input = invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {};
                    const inputRecord = asRecord(input);
                    const requestedTitle = inputRecord ? asString(inputRecord.title) : null;
                    if (isHapiChangeTitleToolName(name) && requestedTitle) {
                        runtime.pendingTitleByCallId.set(callId, requestedTitle);
                    }
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name,
                        callId,
                        input,
                        startedAt,
                        id: randomUUID()
                    });
                    const label = displayMcpToolName(name);
                    runtime.activeToolsByCallId.set(callId, {
                        name,
                        label,
                        activity: formatActivity('Calling tool', label),
                        activityKind: 'tool'
                    });
                    updateActivity(formatActivity('Calling tool', label), 'tool');
                }
                return;
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(runtime.toolStartedAtByCallId, callId);
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const rawResult = msg.result;
                    let output = rawResult;
                    let isError = false;
                    const resultRecord = asRecord(rawResult);
                    if (resultRecord) {
                        if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                            output = resultRecord.Ok;
                        } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                            output = resultRecord.Err;
                            isError = true;
                        }
                    }
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        ...timing,
                        id: randomUUID()
                    });
                    const title = runtime.pendingTitleByCallId.get(callId);
                    runtime.pendingTitleByCallId.delete(callId);
                    updateActivity(
                        formatActivity(isError ? 'Tool failed' : 'Tool finished', activeTool?.label ?? displayMcpToolName(asString(msg.tool) ?? 'tool')),
                        isError ? 'tool-failed' : 'tool-completed',
                        !isError && title ? { summary: title } : undefined
                    );
                }
                return;
            }
            if (msgType === 'codex_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name);
                if (callId && name) {
                    if (isCodexAgentToolName(name)) {
                        const error = 'Nested agent calls are disabled for child agents.';
                        runtime.blockedNestedAgent = true;
                        emitAgentRunTraceMessage(agentId, {
                            type: 'tool-call',
                            name,
                            callId,
                            input: msg.input ?? {},
                            id: randomUUID()
                        });
                        emitAgentRunTraceMessage(agentId, {
                            type: 'tool-call-result',
                            callId,
                            output: error,
                            is_error: true,
                            id: randomUUID()
                        });
                        emitAgentRunUpdate(agentId, {
                            status: 'failed',
                            statusText: 'Failed',
                            activity: formatActivity('Failed', error),
                            activityKind: 'failed',
                            error
                        });
                        return;
                    }
                    const startedAt = beginToolTiming(runtime.toolStartedAtByCallId, callId);
                    const activity = formatActivity('Running tool', name);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call',
                        name,
                        callId,
                        input: msg.input ?? {},
                        startedAt,
                        id: randomUUID()
                    });
                    runtime.activeToolsByCallId.set(callId, {
                        name,
                        label: name,
                        activity,
                        activityKind: 'tool'
                    });
                    updateActivity(activity, 'tool');
                }
                return;
            }
            if (msgType === 'codex_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(runtime.toolStartedAtByCallId, callId);
                    const activeTool = runtime.activeToolsByCallId.get(callId);
                    runtime.activeToolsByCallId.delete(callId);
                    const isError = Boolean(msg.is_error ?? msg.isError);
                    emitAgentRunTraceMessage(agentId, {
                        type: 'tool-call-result',
                        callId,
                        output: msg.output,
                        is_error: isError,
                        ...timing,
                        id: randomUUID()
                    });
                    updateActivity(
                        formatActivity(isError ? 'Tool failed' : 'Tool finished', activeTool?.label ?? 'tool'),
                        isError ? 'tool-failed' : 'tool-completed'
                    );
                }
                return;
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    runtime.diffProcessor.processDiff(diff);
                    updateActivity(formatActivity('Editing files', summarizeDiffFiles(diff)), 'editing');
                }
                return;
            }
            if (isChildTerminalEvent) {
                runtime.terminal = true;
                runtime.reasoningProcessor.reset();
                runtime.diffProcessor.reset();
                runtime.toolStartedAtByCallId.clear();
                runtime.activeToolsByCallId.clear();
                runtime.pendingTitleByCallId.clear();
                runtime.reasoningPreview = '';
                if (msgType === 'task_failed') {
                    const error = asString(msg.error) ?? 'Task failed';
                    emitAgentRunUpdate(agentId, {
                        status: 'failed',
                        statusText: 'Failed',
                        activity: formatActivity('Failed', error),
                        activityKind: 'failed',
                        error
                    });
                } else if (msgType === 'turn_aborted') {
                    emitAgentRunUpdate(agentId, {
                        status: 'canceled',
                        statusText: 'Canceled',
                        activity: 'Canceled',
                        activityKind: 'canceled'
                    });
                } else {
                    const result = runtime.finalMessage;
                    emitAgentRunUpdate(agentId, {
                        status: 'completed',
                        statusText: 'Completed',
                        activity: formatActivity('Completed', result),
                        activityKind: 'completed',
                        ...(result ? { result } : {})
                    });
                }
            }
        };

        let activeMessage: QueuedMessage | null = null;
        let sameThreadRetryAttempt = 0;
        let sameThreadCompactAttempt = 0;
        let recoveryInFlight = false;
        let compactRecovery: {
            threadId: string;
            message: QueuedMessage;
            timeout: ReturnType<typeof setTimeout> | null;
        } | null = null;
        let loopWakeWaiter: (() => void) | null = null;

        const wakeLoop = () => {
            const waiter = loopWakeWaiter;
            if (!waiter) {
                return;
            }
            loopWakeWaiter = null;
            waiter();
        };

        const waitForTurnOrRecovery = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
            if (!turnInFlight && !recoveryInFlight) {
                resolve();
                return;
            }

            const finish = () => {
                if (loopWakeWaiter === finish) {
                    loopWakeWaiter = null;
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };

            loopWakeWaiter = finish;
            signal.addEventListener('abort', finish, { once: true });
        });

        const clearCompactRecovery = (recovery: typeof compactRecovery) => {
            if (!recovery) {
                return;
            }
            if (recovery.timeout) {
                clearTimeout(recovery.timeout);
            }
            if (compactRecovery === recovery) {
                compactRecovery = null;
            }
            recoveryInFlight = false;
            wakeLoop();
        };

        const sendTaskStatus = (
            terminalMessage: string,
            args: Omit<Parameters<typeof buildCodexTaskStatusEvent>[0], 'message'> & { eventMessage?: string }
        ) => {
            const { eventMessage, ...eventArgs } = args;
            messageBuffer.addMessage(terminalMessage, 'status');
            session.sendSessionEvent(buildCodexTaskStatusEvent({
                ...eventArgs,
                message: eventMessage ?? terminalMessage.replace(/^Task failed:\s*/i, '')
            }));
        };

        const failCompactRecovery = (recovery: typeof compactRecovery, message: string) => {
            if (!recovery || compactRecovery !== recovery) {
                return;
            }
            logger.warn(`[Codex] ${message}`);
            sendTaskStatus(message, {
                status: 'failed',
                code: 'context_window',
                recoverable: false
            });
            activeMessage = null;
            clearCompactRecovery(recovery);
        };

        const completeCompactRecovery = (threadId: string | null) => {
            const recovery = compactRecovery;
            if (!recovery) {
                return false;
            }
            if (!threadId || threadId !== recovery.threadId) {
                return false;
            }
            if (!this.shouldExit && this.currentThreadId === recovery.threadId) {
                pending = recovery.message;
                const message = 'Context compacted; retrying same conversation';
                sendTaskStatus(message, {
                    status: 'compacted',
                    code: 'context_window',
                    recoverable: true
                });
            }
            clearCompactRecovery(recovery);
            return true;
        };

        const beginCompactRecovery = (threadId: string, messageToRetry: QueuedMessage, error: string | null) => {
            sameThreadCompactAttempt += 1;
            recoveryInFlight = true;
            const recovery = {
                threadId,
                message: messageToRetry,
                timeout: null as ReturnType<typeof setTimeout> | null
            };
            compactRecovery = recovery;
            recovery.timeout = setTimeout(() => {
                failCompactRecovery(
                    recovery,
                    'Task failed: context window overflow and same-conversation compact timed out'
                );
            }, SAME_THREAD_COMPACT_TIMEOUT_MS);
            recovery.timeout.unref?.();

            logger.debug(
                `[Codex] Compacting retryable context failure on same thread ` +
                `(attempt ${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES}): ${error ?? 'unknown error'}`
            );
            void appServerClient.compactThread({ threadId }, { signal: this.abortController.signal })
                .catch((compactError) => {
                    logger.warn('[Codex] Failed to start app-server thread compact before retry:', compactError);
                    failCompactRecovery(
                        recovery,
                        'Task failed: context window overflow and same-conversation compact failed'
                    );
                });
        };

        const forwardedGoalSignaturesByThreadId = new Map<string, string>();
        const forwardedGoalClearsByThreadId = new Set<string>();
        const adminInterruptedTurnIds = new Set<string>();
        const adminInterruptedTurnTimers = new Map<string, ReturnType<typeof setTimeout>>();

        const suppressReadyForInterruptedTurn = (turnId: string | null) => {
            if (!turnId) {
                return;
            }
            adminInterruptedTurnIds.add(turnId);
            const previousTimer = adminInterruptedTurnTimers.get(turnId);
            if (previousTimer) {
                clearTimeout(previousTimer);
            }
            const timer = setTimeout(() => {
                adminInterruptedTurnIds.delete(turnId);
                adminInterruptedTurnTimers.delete(turnId);
            }, 30_000);
            timer.unref?.();
            adminInterruptedTurnTimers.set(turnId, timer);
        };

        const consumeInterruptedTurnReadySuppression = (turnId: string | null): boolean => {
            if (!turnId || !adminInterruptedTurnIds.has(turnId)) {
                return false;
            }
            adminInterruptedTurnIds.delete(turnId);
            const timer = adminInterruptedTurnTimers.get(turnId);
            if (timer) {
                clearTimeout(timer);
                adminInterruptedTurnTimers.delete(turnId);
            }
            return true;
        };

        const shouldForwardGoalUpdate = (msg: Record<string, unknown>, threadId: string | null): boolean => {
            const goal = asRecord(msg.goal);
            const scopedThreadId = threadId
                ?? asString(goal?.threadId ?? goal?.thread_id)
                ?? this.currentThreadId;
            if (!goal || !scopedThreadId) {
                return true;
            }

            const signature = goalForwardSignatureKey(buildGoalForwardSignature(goal));
            if (forwardedGoalSignaturesByThreadId.get(scopedThreadId) === signature) {
                logger.debug(`[Codex] Suppressing duplicate thread goal update; threadId=${scopedThreadId}`);
                return false;
            }

            forwardedGoalClearsByThreadId.delete(scopedThreadId);
            forwardedGoalSignaturesByThreadId.set(scopedThreadId, signature);
            return true;
        };

        const shouldForwardGoalClear = (threadId: string | null): boolean => {
            if (!threadId) {
                return true;
            }
            if (forwardedGoalClearsByThreadId.has(threadId)) {
                logger.debug(`[Codex] Suppressing duplicate thread goal clear; threadId=${threadId}`);
                return false;
            }
            forwardedGoalClearsByThreadId.add(threadId);
            forwardedGoalSignaturesByThreadId.delete(threadId);
            return true;
        };

        let codexEventQueue: Promise<void> | null = null;

        const handleCodexEvent = async (msg: Record<string, unknown>): Promise<void> => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            const eventTurnId = asString(msg.turn_id ?? msg.turnId);
            const eventThreadId = asString(msg.thread_id ?? msg.threadId);
            const isTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';
            const suppressReadyForThisTerminalEvent = isTerminalEvent
                ? consumeInterruptedTurnReadySuppression(eventTurnId)
                : false;

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    if (!this.currentThreadId || this.currentThreadId === threadId) {
                        this.currentThreadId = threadId;
                        session.onSessionFound(threadId);
                    } else {
                        captureChildAgentConfiguration(threadId, msg);
                    }
                }
                return;
            }

            if (msgType === 'thread_compacted') {
                completeCompactRecovery(eventThreadId);
                return;
            }

            if (eventThreadId && this.currentThreadId && eventThreadId !== this.currentThreadId) {
                logger.debug(
                    `[Codex] Routing event from non-active thread into agent trace; ` +
                    `type=${msgType}, eventThreadId=${eventThreadId}, activeThread=${this.currentThreadId}`
                );
                captureChildAgentConfiguration(eventThreadId, msg);
                if (msgType === 'task_started') {
                    if (eventTurnId) {
                        this.activeChildTurns.set(eventThreadId, eventTurnId);
                    } else {
                        logger.debug(`[Codex] Child task_started missing turn id; threadId=${eventThreadId}`);
                    }
                    linkPendingAgentStartFromChildTask(eventThreadId);
                } else if (isTerminalEvent) {
                    this.activeChildTurns.delete(eventThreadId);
                }
                handleChildCodexEvent(eventThreadId, msg);
                return;
            }

            if (!eventThreadId && this.currentThreadId && isScopeSensitiveCodexEvent(msgType) && hasKnownChildAgents()) {
                logger.debug(
                    `[Codex] Dropping unscoped scope-sensitive event while child agents are active; ` +
                    `type=${msgType}, activeThread=${this.currentThreadId}`
                );
                return;
            }

            if (msgType === 'thread_goal_updated') {
                if (shouldForwardGoalUpdate(msg, eventThreadId)) {
                    session.sendAgentMessage({
                        ...addCodexEventScope(msg, 'parent', eventThreadId ?? this.currentThreadId),
                        id: randomUUID()
                    });
                }
                return;
            }

            if (msgType === 'thread_goal_cleared') {
                if (!shouldForwardGoalClear(eventThreadId ?? this.currentThreadId)) {
                    return;
                }
                session.sendAgentMessage({
                    ...addCodexEventScope(msg, 'parent', eventThreadId ?? this.currentThreadId),
                    id: randomUUID()
                });
                return;
            }

            if (msgType === 'task_started') {
                const turnId = eventTurnId;
                if (turnId) {
                    this.currentTurnId = turnId;
                    allowAnonymousTerminalEvent = false;
                } else if (!this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            }

            const isThreadStatusFailure = msgType === 'task_failed' && msg.terminal_source === 'thread_status';
            const error = msgType === 'task_failed' ? asString(msg.error) : null;
            const shouldCompactAndRetrySameThread = msgType === 'task_failed'
                && isContextCompactRetryableCodexError(error)
                && Boolean(activeMessage)
                && Boolean(this.currentThreadId)
                && sameThreadCompactAttempt < SAME_THREAD_MAX_COMPACT_RETRIES;
            const shouldRetrySameThread = msgType === 'task_failed'
                && !shouldCompactAndRetrySameThread
                && isSameThreadRetryableCodexError(error)
                && Boolean(activeMessage)
                && Boolean(this.currentThreadId)
                && sameThreadRetryAttempt < SAME_THREAD_MAX_RETRIES;

            if (isTerminalEvent) {
                if (shouldIgnoreTerminalEvent({
                    eventTurnId,
                    currentTurnId: this.currentTurnId,
                    turnInFlight,
                    allowAnonymousTerminalEvent,
                    eventThreadId,
                    currentThreadId: this.currentThreadId,
                    allowMatchingThreadIdTerminalEvent: msg.terminal_source === 'thread_status'
                })) {
                    logger.debug(
                        `[Codex] Ignoring terminal event ${msgType} without matching turn context; ` +
                        `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}, ` +
                        `eventThreadId=${eventThreadId ?? 'none'}, activeThread=${this.currentThreadId ?? 'none'}, ` +
                        `turnInFlight=${turnInFlight}, allowAnonymous=${allowAnonymousTerminalEvent}`
                    );
                    return;
                }
                if (shouldCompactAndRetrySameThread) {
                    const threadId = this.currentThreadId;
                    const messageToRetry = activeMessage;
                    if (threadId && messageToRetry) {
                        beginCompactRecovery(threadId, messageToRetry, error);
                    }
                } else if (shouldRetrySameThread) {
                    sameThreadRetryAttempt += 1;
                    pending = activeMessage;
                    logger.debug(
                        `[Codex] Retrying retryable failure on same thread ` +
                        `(attempt ${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES}): ${error ?? 'unknown error'}`
                    );
                }
                this.currentTurnId = null;
                allowAnonymousTerminalEvent = false;
                if (isThreadStatusFailure && !shouldRetrySameThread && !shouldCompactAndRetrySameThread) {
                    logger.warn(`[Codex] Thread-level failure on ${eventThreadId ?? this.currentThreadId ?? 'unknown thread'}; preserving same conversation`);
                }
            }

            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    messageBuffer.addMessage(message, 'assistant');
                }
            } else if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
                }
            } else if (msgType === 'exec_command_begin') {
                const command = normalizeCommand(msg.command) ?? 'command';
                messageBuffer.addMessage(`Executing: ${command}`, 'tool');
            } else if (msgType === 'exec_command_end') {
                const output = msg.output ?? msg.error ?? 'Command completed';
                const outputText = formatOutputPreview(output);
                const truncatedOutput = outputText.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                    'result'
                );
            } else if (msgType === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
            } else if (msgType === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
            } else if (msgType === 'task_failed') {
                if (shouldCompactAndRetrySameThread) {
                    const retryMessage = error
                        ? `Task failed: ${error}; compacting same conversation before retry (${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES})`
                        : `Task failed; compacting same conversation before retry (${sameThreadCompactAttempt}/${SAME_THREAD_MAX_COMPACT_RETRIES})`;
                    sendTaskStatus(retryMessage, {
                        status: 'compacting',
                        eventMessage: error ?? 'Task failed',
                        retryAttempt: sameThreadCompactAttempt,
                        maxRetries: SAME_THREAD_MAX_COMPACT_RETRIES,
                        recoverable: true
                    });
                } else if (shouldRetrySameThread) {
                    const retryMessage = error
                        ? `Task failed: ${error}; retrying same conversation (${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES})`
                        : `Task failed; retrying same conversation (${sameThreadRetryAttempt}/${SAME_THREAD_MAX_RETRIES})`;
                    sendTaskStatus(retryMessage, {
                        status: 'retrying',
                        eventMessage: error ?? 'Task failed',
                        retryAttempt: sameThreadRetryAttempt,
                        maxRetries: SAME_THREAD_MAX_RETRIES,
                        recoverable: true
                    });
                } else {
                    const message = error ? `Task failed: ${error}` : 'Task failed';
                    sendTaskStatus(message, {
                        status: 'failed',
                        eventMessage: error ?? 'Task failed',
                        recoverable: false
                    });
                }
            }

            if (msgType === 'task_started') {
                clearReadyAfterTurnTimer?.();
                turnInFlight = true;
                if (!eventTurnId && !this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (isTerminalEvent) {
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
                appServerEventConverter.reset();
                mcpTitleByCallId.clear();
                toolStartedAtByCallId.clear();
                pendingAgentToolInputByCallId.clear();
                childAgentActivityInCurrentTurn = false;
                wakeLoop();
            }

            if (isTerminalEvent && !turnInFlight && !suppressReadyForThisTerminalEvent) {
                scheduleReadyAfterTurn?.();
            } else if (readyAfterTurnTimer && msgType !== 'task_started' && !suppressReadyForThisTerminalEvent) {
                scheduleReadyAfterTurn?.();
            }

            if (msgType === 'task_complete') {
                sameThreadRetryAttempt = 0;
                sameThreadCompactAttempt = 0;
                recoveryInFlight = false;
                clearCompactRecovery(compactRecovery);
                activeMessage = null;
            }

            if (msgType === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    reasoningProcessor.processDelta(delta);
                }
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    reasoningProcessor.complete(text);
                }
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    const itemId = asString(msg.item_id ?? msg.itemId);
                    const streamId = asString(msg.stream_id ?? msg.streamId) ?? itemId;
                    session.sendAgentMessage({
                        type: 'message',
                        message,
                        streamId: streamId ?? undefined,
                        itemId: itemId ?? undefined,
                        final: Boolean(msg.final),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_session_event') {
                const eventType = asString(msg.event_type ?? msg.eventType);
                if (eventType) {
                    session.sendAgentMessage({
                        type: 'codex-session-event',
                        eventType,
                        current: msg.current,
                        total: msg.total,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'agent_message_snapshot') {
                const message = asString(msg.message);
                const itemId = asString(msg.item_id ?? msg.itemId);
                const streamId = asString(msg.stream_id ?? msg.streamId) ?? itemId;
                if (message && streamId) {
                    session.sendAgentMessage({
                        type: 'message-snapshot',
                        message,
                        streamId,
                        itemId: itemId ?? undefined,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'generated_image') {
                const sourceImageId = asString(msg.image_id ?? msg.imageId ?? msg.id);
                const imageId = randomUUID();
                const savedPath = asString(msg.saved_path ?? msg.savedPath);
                if (savedPath) {
                    const image = await registerGeneratedImageFromPath({
                        id: imageId,
                        path: savedPath,
                        fileName: asString(msg.file_name ?? msg.fileName)
                    });
                    if (!image) return;

                    await session.client.persistGeneratedImage(image);

                    messageBuffer.addMessage(`Generated image: ${image.fileName}`, 'assistant');
                    session.sendAgentMessage({
                        type: 'generated-image',
                        imageId: image.id,
                        sourceImageId,
                        fileName: image.fileName,
                        mimeType: image.mimeType,
                        sourcePath: image.path,
                        sourceMachineId: session.client.getMachineId() ?? undefined,
                        size: image.size,
                        mtimeMs: image.mtimeMs,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const startedAt = beginToolTiming(toolStartedAtByCallId, callId);
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: callId,
                        input: inputs,
                        startedAt,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(toolStartedAtByCallId, callId);
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;
                    output.stdout = output.output;
                    delete output.output;

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output,
                        ...timing,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                const threadId = eventThreadId ?? this.currentThreadId;
                session.sendAgentMessage({
                    ...addCodexEventScope(msg, 'parent', threadId),
                    id: randomUUID()
                });
            }
            if (msgType === 'context_compacted') {
                const threadId = eventThreadId ?? this.currentThreadId;
                session.sendAgentMessage({
                    ...addCodexEventScope({
                        type: 'context_compacted',
                        ...(eventTurnId ? { turn_id: eventTurnId } : {})
                    }, 'parent', threadId),
                    id: randomUUID()
                });
            }
            if (msgType === 'plan_update') {
                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'update_plan',
                    callId: 'codex-plan-state',
                    input: {
                        plan: Array.isArray(msg.plan) ? msg.plan : [],
                        source: 'codex'
                    },
                    id: randomUUID()
                });
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: 'codex-plan-state',
                    output: {
                        plan: Array.isArray(msg.plan) ? msg.plan : [],
                        source: 'codex',
                        status: 'updated'
                    },
                    id: randomUUID()
                });
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const startedAt = beginToolTiming(toolStartedAtByCallId, callId);
                    const changes = msg.changes ?? {};
                    const changeCount = Object.keys(changes).length;
                    const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                    messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId: callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        startedAt,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const timing = completeToolTiming(toolStartedAtByCallId, callId);
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);

                    if (success) {
                        const message = stdout || 'Files modified successfully';
                        messageBuffer.addMessage(message.substring(0, 200), 'result');
                    } else {
                        const errorMsg = stderr || 'Failed to modify files';
                        messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: {
                            stdout,
                            stderr,
                            success
                        },
                        ...timing,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    const startedAt = beginToolTiming(toolStartedAtByCallId, callId);
                    const input = invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {};
                    const inputRecord = asRecord(input);
                    const requestedTitle = inputRecord ? asString(inputRecord.title) : null;
                    if (isHapiChangeTitleToolName(name) && requestedTitle) {
                        mcpTitleByCallId.set(callId, requestedTitle);
                    }
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input,
                        startedAt,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const rawResult = msg.result;
                let output = rawResult;
                let isError = false;
                const resultRecord = asRecord(rawResult);
                if (resultRecord) {
                    if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                        output = resultRecord.Ok;
                    } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                        output = resultRecord.Err;
                        isError = true;
                    }
                }

                if (callId) {
                    const timing = completeToolTiming(toolStartedAtByCallId, callId);
                    const title = mcpTitleByCallId.get(callId);
                    mcpTitleByCallId.delete(callId);
                    if (!isError && title) {
                        sendTitleSummary(title);
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        ...timing,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name);
                if (callId && name) {
                    if (isCodexAgentToolName(name)) {
                            const input = msg.input ?? {};
                            pendingAgentToolInputByCallId.set(callId, { name, input });
                            if (name === 'spawn_agent') {
                                if (pendingSideSessionFork && pendingSideSessionFork.callId === null) {
                                    pendingSideSessionFork.callId = callId;
                                }
                                emitAgentRunStart(callId, input);
                            } else {
                                for (const agentId of extractAgentTargets(input)) {
                                    if (!agentCardByAgentId.has(agentId)) {
                                        continue;
                                    }
                                    const activity = name === 'wait_agent'
                                        ? 'Waiting for agent'
                                        : name === 'send_input'
                                            ? 'Sending input'
                                        : name === 'resume_agent'
                                            ? 'Resuming agent'
                                            : name === 'close_agent'
                                                ? 'Closing agent'
                                                : 'Running agent tool';
                                emitAgentRunUpdate(agentId, {
                                    status: 'running',
                                    statusText: activity,
                                    activity,
                                    activityKind: name
                                });
                            }
                        }
                        return;
                    }
                    const startedAt = beginToolTiming(toolStartedAtByCallId, callId);
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: msg.input ?? {},
                        startedAt,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const name = asString(msg.name) ?? pendingAgentToolInputByCallId.get(callId ?? '')?.name ?? null;
                if (callId) {
                    if (name && isCodexAgentToolName(name)) {
                        handleAgentToolEnd(callId, name, msg.output, Boolean(msg.is_error ?? msg.isError));
                        return;
                    }
                    const timing = completeToolTiming(toolStartedAtByCallId, callId);
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: msg.output,
                        is_error: Boolean(msg.is_error ?? msg.isError),
                        ...timing,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        registerAppServerPermissionHandlers({
            client: appServerClient,
            permissionHandler,
            getPermissionMode: getCurrentCodexPermissionMode,
            onUserInputRequest: async ({ id, input }) => {
                try {
                    const answers = await permissionHandler.handleUserInputRequest(id, input);
                    return {
                        decision: 'accept',
                        answers
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`[Codex] request_user_input failed: ${message}`);
                    return {
                        decision: 'cancel'
                    };
                }
            }
        });

        appServerClient.setNotificationHandler((method, params) => {
            const events = appServerEventConverter.handleNotification(method, params);
            for (const event of events) {
                const eventRecord = asRecord(event) ?? { type: undefined };
                const msgType = asString(eventRecord.type);
                const hasGeneratedImagePath = msgType === 'generated_image' && Boolean(asString(eventRecord.saved_path ?? eventRecord.savedPath));

                if (codexEventQueue || hasGeneratedImagePath) {
                    const previousQueue = codexEventQueue ?? Promise.resolve();
                    const nextQueue = previousQueue
                        .then(() => handleCodexEvent(eventRecord))
                        .catch((error) => logger.debug('[Codex] Failed to handle app-server event:', error instanceof Error ? error.message : String(error)));
                    const queued = nextQueue.finally(() => {
                        if (codexEventQueue === queued) {
                            codexEventQueue = null;
                        }
                    });
                    codexEventQueue = queued;
                } else {
                    void handleCodexEvent(eventRecord).catch((error) => {
                        logger.debug('[Codex] Failed to handle app-server event:', error instanceof Error ? error.message : String(error));
                    });
                }
            }
        });

        appServerClient.setStderrHandler((text) => {
            const spawnAgentError = extractSpawnAgentStartErrorFromStderr(text);
            if (!spawnAgentError || pendingAgentStartCardIds.size === 0) {
                return;
            }
            logger.debug(
                `[Codex] Failing ${pendingAgentStartCardIds.size} pending spawn_agent start(s) ` +
                `from app-server stderr: ${spawnAgentError}`
            );
            failPendingAgentStartsForSpawnArgumentError(spawnAgentError);
        });

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            // In app-server/collab mode, child agents share this MCP bridge.
            // If the MCP handler writes the title directly, child title calls
            // leak into the parent SHAPI session. Defer the side effect until
            // parent-thread mcp_tool_call_end reaches this launcher; child
            // events are filtered above by thread id.
            emitTitleSummary: false
        });
        this.happyServer = happyServer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        await appServerClient.connect();
        await appServerClient.initialize({
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });
        let supportsTurnCollaborationMode = true;
        let supportsGoals = true;
        try {
            await appServerClient.setExperimentalFeatureEnablement({ enablement: { goals: true } });
            logger.debug('[Codex] goals feature enabled');
        } catch (error) {
            logger.debug(`[Codex] failed to enable goals feature: ${errorMessage(error)}; will rely on configured feature state`);
        }
        try {
            const response = await appServerClient.listCollaborationModes();
            const hasPlanMode = responseContainsPlanCollaborationMode(response);
            logger.debug(`[Codex] collaborationMode/list plan=${hasPlanMode}`);
            if (!hasPlanMode) {
                logger.debug('[Codex] collaborationMode/list did not report plan; will still attempt collaborationMode until rejected');
            }
        } catch (error) {
            logger.debug(`[Codex] collaborationMode/list failed: ${errorMessage(error)}`);
        }

        let hasThread = false;
        let pending: QueuedMessage | null = null;
        let suppressReadyForAdminCommand = false;

        clearReadyAfterTurnTimer = () => {
            if (!readyAfterTurnTimer) {
                return;
            }
            clearTimeout(readyAfterTurnTimer);
            readyAfterTurnTimer = null;
        };

        scheduleReadyAfterTurn = () => {
            clearReadyAfterTurnTimer?.();
            if (suppressReadyForAdminCommand) {
                return;
            }
            readyAfterTurnTimer = setTimeout(() => {
                readyAfterTurnTimer = null;
                if (suppressReadyForAdminCommand) {
                    return;
                }
                emitReadyIfIdle({
                    pending: pending ?? (recoveryInFlight ? activeMessage : null),
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
            }, 120);
            readyAfterTurnTimer.unref?.();
        };

        const sendVisibleStatus = (message: string) => {
            messageBuffer.addMessage(message, 'status');
            session.sendSessionEvent({ type: 'message', message });
        };

        const sendGoalEvent = (event: Record<string, unknown>) => {
            const threadId = asString(event.thread_id ?? event.threadId) ?? this.currentThreadId;
            if (event.type === 'thread_goal_cleared') {
                if (!shouldForwardGoalClear(threadId)) {
                    return;
                }
            } else if (event.type === 'thread_goal_updated' && !shouldForwardGoalUpdate(event, threadId)) {
                return;
            }
            session.sendAgentMessage({
                ...addCodexEventScope(event, 'parent', this.currentThreadId),
                id: randomUUID()
            });
        };

        const resetCurrentTurnState = () => {
            turnInFlight = false;
            allowAnonymousTerminalEvent = false;
            this.currentTurnId = null;
            permissionHandler.reset();
            reasoningProcessor.abort();
            diffProcessor.reset();
            appServerEventConverter.reset();
            session.onThinkingChange(false);
        };

        const interruptActiveTurn = async () => {
            suppressReadyForInterruptedTurn(this.currentTurnId);
            await this.interruptActiveTurns('slash command');
        };

        const resumeExistingThreadForCompact = async (mode: EnhancedMode): Promise<string | null> => {
            if (this.currentThreadId && this.currentThreadId !== invalidThreadId) {
                hasThread = true;
                return this.currentThreadId;
            }

            const resumeCandidate = session.sessionId && session.sessionId !== invalidThreadId
                ? session.sessionId
                : null;
            if (!resumeCandidate) {
                return null;
            }

            const threadParams = buildThreadStartParams({
                cwd: session.path,
                mode,
                mcpServers,
                cliOverrides: session.codexCliOverrides
            });

            try {
                const resumeResponse = await appServerClient.resumeThread({
                    threadId: resumeCandidate,
                    ...threadParams
                }, {
                    signal: this.abortController.signal
                });
                const resumeRecord = asRecord(resumeResponse);
                const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                const threadId = asString(resumeThread?.id) ?? resumeCandidate;
                applyResolvedModel(resumeRecord?.model);
                this.currentThreadId = threadId;
                session.onSessionFound(threadId);
                hasThread = true;
                logger.debug(`[Codex] Resumed app-server thread ${threadId} for /compact`);
                return threadId;
            } catch (error) {
                logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate} for /compact`, error);
                return null;
            }
        };

        const parseGoalCommand = (text: string): {
            action: 'show' | 'set' | 'pause' | 'resume' | 'clear';
            objective?: string;
            error?: string;
        } | null => {
            const match = /^\s*\/goal(?:\s+([\s\S]*))?$/i.exec(text);
            if (!match) return null;
            const rest = match[1]?.trim() ?? '';
            if (!rest) return { action: 'show' };
            switch (rest.toLowerCase()) {
                case 'clear':
                    return { action: 'clear' };
                case 'pause':
                    return { action: 'pause' };
                case 'resume':
                    return { action: 'resume' };
                default:
                    if ([...rest].length > MAX_CODEX_GOAL_OBJECTIVE_CHARS) {
                        return { action: 'set', error: `Goal objective must be at most ${MAX_CODEX_GOAL_OBJECTIVE_CHARS} characters.` };
                    }
                    return { action: 'set', objective: rest };
            }
        };

        const ensureThreadForGoal = async (mode: EnhancedMode): Promise<string | null> => {
            if (this.currentThreadId && this.currentThreadId !== invalidThreadId) {
                hasThread = true;
                return this.currentThreadId;
            }

            const resumeCandidate = session.sessionId && session.sessionId !== invalidThreadId
                ? session.sessionId
                : null;
            if (resumeCandidate) {
                const threadParams = buildThreadStartParams({
                    cwd: session.path,
                    mode,
                    mcpServers,
                    cliOverrides: session.codexCliOverrides
                });
                try {
                    const resumeResponse = await appServerClient.resumeThread({
                        threadId: resumeCandidate,
                        ...threadParams
                    }, {
                        signal: this.abortController.signal
                    });
                    const resumeRecord = asRecord(resumeResponse);
                    const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                    const threadId = asString(resumeThread?.id) ?? resumeCandidate;
                    applyResolvedModel(resumeRecord?.model);
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                    hasThread = true;
                    return threadId;
                } catch (error) {
                    logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate} for /goal`, error);
                    sendVisibleStatus(`Goal failed: Codex conversation ${resumeCandidate} could not be resumed`);
                    return null;
                }
            }

            if (!hasThread) {
                const threadParams = buildThreadStartParams({
                    cwd: session.path,
                    mode,
                    mcpServers,
                    cliOverrides: session.codexCliOverrides
                });
                const threadResponse = await appServerClient.startThread(threadParams, {
                    signal: this.abortController.signal
                });
                const threadRecord = asRecord(threadResponse);
                const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                const threadId = asString(thread?.id);
                applyResolvedModel(threadRecord?.model);
                if (!threadId) {
                    throw new Error('app-server thread/start did not return thread.id');
                }
                this.currentThreadId = threadId;
                session.onSessionFound(threadId);
                hasThread = true;
                return threadId;
            }

            return null;
        };

        const ensureThreadForReview = async (mode: EnhancedMode): Promise<string | null> => {
            if (this.currentThreadId && this.currentThreadId !== invalidThreadId) {
                hasThread = true;
                return this.currentThreadId;
            }

            const resumeCandidate = session.sessionId && session.sessionId !== invalidThreadId
                ? session.sessionId
                : null;
            if (resumeCandidate) {
                const threadParams = buildThreadStartParams({
                    cwd: session.path,
                    mode,
                    mcpServers,
                    cliOverrides: session.codexCliOverrides
                });
                try {
                    const resumeResponse = await appServerClient.resumeThread({
                        threadId: resumeCandidate,
                        ...threadParams
                    }, {
                        signal: this.abortController.signal
                    });
                    const resumeRecord = asRecord(resumeResponse);
                    const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                    const threadId = asString(resumeThread?.id) ?? resumeCandidate;
                    applyResolvedModel(resumeRecord?.model);
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                    hasThread = true;
                    return threadId;
                } catch (error) {
                    logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate} for /review`, error);
                    sendVisibleStatus(`Code review failed: Codex conversation ${resumeCandidate} could not be resumed`);
                    return null;
                }
            }

            const threadParams = buildThreadStartParams({
                cwd: session.path,
                mode,
                mcpServers,
                cliOverrides: session.codexCliOverrides
            });
            const threadResponse = await appServerClient.startThread(threadParams, {
                signal: this.abortController.signal
            });
            const threadRecord = asRecord(threadResponse);
            const thread = threadRecord ? asRecord(threadRecord.thread) : null;
            const threadId = asString(thread?.id);
            applyResolvedModel(threadRecord?.model);
            if (!threadId) {
                throw new Error('app-server thread/start did not return thread.id');
            }
            this.currentThreadId = threadId;
            session.onSessionFound(threadId);
            hasThread = true;
            return threadId;
        };

        const formatReviewTarget = (target: ReviewTarget): string => {
            switch (target.type) {
                case 'uncommittedChanges':
                    return 'uncommitted changes';
                case 'baseBranch':
                    return `base branch ${target.branch}`;
                case 'commit':
                    return target.title ? `commit ${target.sha} (${target.title})` : `commit ${target.sha}`;
                case 'custom':
                    return 'custom instructions';
            }
        };

        const normalizeGoal = (goal: ThreadGoal): ThreadGoal => ({
            ...goal,
            threadId: asString((goal as unknown as Record<string, unknown>).threadId ?? (goal as unknown as Record<string, unknown>).thread_id) ?? goal.threadId,
            tokenBudget: (goal as unknown as Record<string, unknown>).tokenBudget as number | null | undefined
                ?? (goal as unknown as Record<string, unknown>).token_budget as number | null | undefined
                ?? null,
            tokensUsed: (goal as unknown as Record<string, unknown>).tokensUsed as number | undefined
                ?? (goal as unknown as Record<string, unknown>).tokens_used as number | undefined
                ?? 0,
            timeUsedSeconds: (goal as unknown as Record<string, unknown>).timeUsedSeconds as number | undefined
                ?? (goal as unknown as Record<string, unknown>).time_used_seconds as number | undefined
                ?? 0,
            createdAt: (goal as unknown as Record<string, unknown>).createdAt as number | undefined
                ?? (goal as unknown as Record<string, unknown>).created_at as number | undefined
                ?? 0,
            updatedAt: (goal as unknown as Record<string, unknown>).updatedAt as number | undefined
                ?? (goal as unknown as Record<string, unknown>).updated_at as number | undefined
                ?? 0
        });

        const handleGoalCommand = async (message: QueuedMessage): Promise<boolean> => {
            const command = parseGoalCommand(message.message);
            if (!command) {
                return false;
            }

            await interruptActiveTurn();
            resetCurrentTurnState();

            if (command.error) {
                sendVisibleStatus(command.error);
                return true;
            }

            if (!supportsGoals) {
                sendVisibleStatus(CODEX_GOALS_UNSUPPORTED_MESSAGE);
                return true;
            }

            const threadId = await ensureThreadForGoal(message.mode);
            if (!threadId) {
                return true;
            }

            try {
                if (command.action === 'show') {
                    const response = await appServerClient.getThreadGoal({ threadId }, {
                        signal: this.abortController.signal
                    });
                    const goal = response.goal ? normalizeGoal(response.goal) : null;
                    if (!goal) {
                        sendVisibleStatus('Usage: /goal <objective>');
                        sendGoalEvent({ type: 'thread_goal_cleared', thread_id: threadId });
                        return true;
                    }
                    sendVisibleStatus(formatGoalUsage(goal));
                    sendGoalEvent({ type: 'thread_goal_updated', thread_id: threadId, goal });
                    return true;
                }

                if (command.action === 'clear') {
                    const response = await appServerClient.clearThreadGoal({ threadId }, {
                        signal: this.abortController.signal
                    });
                    if (response.cleared) {
                        sendVisibleStatus('Goal cleared');
                    } else {
                        sendVisibleStatus('No goal to clear');
                    }
                    sendGoalEvent({ type: 'thread_goal_cleared', thread_id: threadId });
                    return true;
                }

                const status: ThreadGoalStatus = command.action === 'pause' ? 'paused' : 'active';
                const response = await appServerClient.setThreadGoal({
                    threadId,
                    ...(command.action === 'set' ? { objective: command.objective } : {}),
                    status
                }, {
                    signal: this.abortController.signal
                });
                const goal = normalizeGoal(response.goal);
                sendVisibleStatus(formatGoalUsage(goal));
                sendGoalEvent({ type: 'thread_goal_updated', thread_id: threadId, goal });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                if (/goals feature is disabled|unsupported remote app-server request|method not found/i.test(detail)) {
                    supportsGoals = false;
                    sendVisibleStatus(CODEX_GOALS_UNSUPPORTED_MESSAGE);
                } else {
                    sendVisibleStatus(`Goal failed: ${detail}`);
                }
            }
            return true;
        };

        const handleSpecialCommand = async (message: QueuedMessage): Promise<boolean> => {
            const specialCommand = parseCodexSpecialCommand(message.message);
            if (!specialCommand.type) {
                return false;
            }

            if (specialCommand.type === 'invalid') {
                await interruptActiveTurn();
                resetCurrentTurnState();
                sendVisibleStatus(specialCommand.message);
                return true;
            }

            if (specialCommand.type === 'clear') {
                await interruptActiveTurn();
                resetCurrentTurnState();
                this.currentThreadId = null;
                invalidThreadId = null;
                hasThread = false;
                session.resetCodexThread();
                sendVisibleStatus('Context was reset');
                return true;
            }

            if (specialCommand.type === 'review') {
                await interruptActiveTurn();
                resetCurrentTurnState();
                let threadId: string | null = null;
                try {
                    threadId = await ensureThreadForReview(message.mode);
                } catch (error) {
                    sendVisibleStatus(`Code review failed: ${errorMessage(error)}`);
                    return true;
                }
                if (!threadId) {
                    return true;
                }

                sendVisibleStatus(`Code review started: ${formatReviewTarget(specialCommand.target)}`);
                try {
                    turnInFlight = true;
                    allowAnonymousTerminalEvent = false;
                    session.onThinkingChange(true);
                    const reviewResponse = await appServerClient.startReview({
                        threadId,
                        target: specialCommand.target,
                        delivery: 'inline'
                    }, {
                        signal: this.abortController.signal
                    });
                    const reviewRecord = asRecord(reviewResponse);
                    const turn = reviewRecord ? asRecord(reviewRecord.turn) : null;
                    const turnId = asString(turn?.id);
                    if (turnInFlight) {
                        if (turnId) {
                            this.currentTurnId = turnId;
                        } else if (!this.currentTurnId) {
                            allowAnonymousTerminalEvent = true;
                        }
                    }
                } catch (error) {
                    resetCurrentTurnState();
                    const detail = errorMessage(error);
                    if (/unsupported remote app-server request|method not found/i.test(detail)) {
                        sendVisibleStatus('Code review is not supported by this Codex runtime.');
                    } else {
                        sendVisibleStatus(`Code review failed: ${detail}`);
                    }
                }
                return true;
            }

            await interruptActiveTurn();
            resetCurrentTurnState();
            const threadId = await resumeExistingThreadForCompact(message.mode);
            if (!threadId) {
                sendVisibleStatus('Nothing to compact');
                return true;
            }

            sendVisibleStatus('Compaction started');
            try {
                await appServerClient.compactThread({ threadId }, {
                    signal: this.abortController.signal
                });
                sendVisibleStatus('Compaction completed');
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                sendVisibleStatus(`Compaction failed: ${detail}`);
            }
            return true;
        };

        const buildSideSessionForkMode = (): EnhancedMode | null => {
            const model = session.getModel();
            if (!model) {
                return null;
            }
            const modelReasoningEffort = session.getModelReasoningEffort() as EnhancedMode['modelReasoningEffort'] | null | undefined;
            return {
                permissionMode: getCurrentCodexPermissionMode() ?? 'default',
                model,
                collaborationMode: 'default',
                ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
                serviceTier: session.getServiceTier()
            };
        };

        const ensureThreadForSideSessionFork = async (mode: EnhancedMode): Promise<string> => {
            if (this.currentThreadId && this.currentThreadId !== invalidThreadId) {
                hasThread = true;
                return this.currentThreadId;
            }

            const resumeCandidate = session.sessionId && session.sessionId !== invalidThreadId
                ? session.sessionId
                : null;
            const threadParams = buildThreadStartParams({
                cwd: session.path,
                mode,
                mcpServers,
                cliOverrides: session.codexCliOverrides
            });

            if (resumeCandidate) {
                const resumeResponse = await appServerClient.resumeThread({
                    threadId: resumeCandidate,
                    ...threadParams
                }, {
                    signal: this.abortController.signal
                });
                const resumeRecord = asRecord(resumeResponse);
                const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                const threadId = asString(resumeThread?.id) ?? resumeCandidate;
                applyResolvedModel(resumeRecord?.model);
                this.currentThreadId = threadId;
                session.onSessionFound(threadId);
                hasThread = true;
                return threadId;
            }

            const threadResponse = await appServerClient.startThread(threadParams, {
                signal: this.abortController.signal
            });
            const threadRecord = asRecord(threadResponse);
            const thread = threadRecord ? asRecord(threadRecord.thread) : null;
            const threadId = asString(thread?.id);
            applyResolvedModel(threadRecord?.model);
            if (!threadId) {
                throw new Error('app-server thread/start did not return thread.id');
            }
            this.currentThreadId = threadId;
            session.onSessionFound(threadId);
            hasThread = true;
            return threadId;
        };

        const sideSessionForkPrompt = [
            'Create a SHAPI side session from the current conversation.',
            'Call spawn_agent exactly once with fork_context: true.',
            'Do not set agent_type, subagent_type, model, or reasoning_effort.',
            'Use this child message: "Initialize a SHAPI side session forked from the current conversation. Do not make code changes or take actions yet. Reply only: Side session ready."',
            'Do not write normal assistant text before or after the tool call.'
        ].join('\n');

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ForkCodexSideSession, async () => {
            if (pendingSideSessionFork) {
                return {
                    type: 'error',
                    code: 'busy',
                    message: 'A side session fork is already in progress'
                };
            }
            if (turnInFlight || recoveryInFlight || pending || session.queue.size() > 0) {
                return {
                    type: 'error',
                    code: 'busy',
                    message: 'Codex is busy; wait for the current turn to finish before creating a side session'
                };
            }

            const mode = buildSideSessionForkMode();
            if (!mode) {
                return {
                    type: 'error',
                    code: 'missing_model',
                    message: 'Codex model is not resolved yet; send one normal message first, then create a side session'
                };
            }

            let parentThreadId: string;
            try {
                parentThreadId = await ensureThreadForSideSessionFork(mode);
            } catch (error) {
                return {
                    type: 'error',
                    code: 'thread_unavailable',
                    message: `Codex conversation could not be prepared: ${errorMessage(error)}`
                };
            }

            let rejectFork: (error: Error) => void = () => {};
            const forkPromise = new Promise<{
                childCodexThreadId: string;
                parentCodexThreadId: string;
            }>((resolve, reject) => {
                rejectFork = reject;
                const timeout = setTimeout(() => {
                    const timedOutFork = takePendingSideSessionFork(parentThreadId);
                    if (!timedOutFork) {
                        return;
                    }
                    reject(new Error('Timed out waiting for Codex to create the side session'));
                }, SIDE_SESSION_FORK_TIMEOUT_MS);
                timeout.unref?.();
                pendingSideSessionFork = {
                    callId: null,
                    parentThreadId,
                    timeout,
                    resolve,
                    reject
                };
            });
            void forkPromise.catch(() => {});

            try {
                suppressReadyForAdminCommand = true;
                clearReadyAfterTurnTimer?.();
                turnInFlight = true;
                allowAnonymousTerminalEvent = false;
                session.onThinkingChange(true);
                const turnResponse = await appServerClient.startTurn(buildTurnStartParams({
                    threadId: parentThreadId,
                    message: sideSessionForkPrompt,
                    cwd: session.path,
                    mode,
                    cliOverrides: session.codexCliOverrides
                }), {
                    signal: this.abortController.signal
                });
                const turnRecord = asRecord(turnResponse);
                const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                const turnId = asString(turn?.id);
                if (turnId) {
                    this.currentTurnId = turnId;
                } else {
                    allowAnonymousTerminalEvent = true;
                }

                const fork = await forkPromise;
                return {
                    type: 'success',
                    ...fork
                };
            } catch (error) {
                rejectFork(error instanceof Error ? error : new Error(String(error)));
                return {
                    type: 'error',
                    code: 'fork_failed',
                    message: errorMessage(error)
                };
            } finally {
                takePendingSideSessionFork(parentThreadId);
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                this.currentTurnId = null;
                suppressReadyForAdminCommand = false;
                session.onThinkingChange(false);
                scheduleReadyAfterTurn?.();
            }
        });

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            if (!pending && (turnInFlight || recoveryInFlight) && session.queue.size() === 0) {
                await waitForTurnOrRecovery(this.abortController.signal);
                if (this.abortController.signal.aborted && !this.shouldExit) {
                    logger.debug('[codex]: Internal wait aborted while turn/recovery was active; continuing');
                    continue;
                }
                continue;
            }

            let message: QueuedMessage | null = pending;
            const isRetryMessage = Boolean(message);
            pending = null;
            if (!message) {
                sameThreadRetryAttempt = 0;
                sameThreadCompactAttempt = 0;
                activeMessage = null;
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (!isRetryMessage) {
                messageBuffer.addMessage(message.message, 'user');
            }
            activeMessage = message;
            const isGoalCommand = parseGoalCommand(message.message) !== null;
            let suppressReadyAfterMessage = isGoalCommand;
            if (isGoalCommand) {
                suppressReadyForAdminCommand = true;
                clearReadyAfterTurnTimer?.();
            }

            try {
                if (await handleGoalCommand(message)) {
                    continue;
                }

                if (await handleSpecialCommand(message)) {
                    continue;
                }

                if (!hasThread) {
                    const threadParams = buildThreadStartParams({
                        cwd: session.path,
                        mode: message.mode,
                        mcpServers,
                        cliOverrides: session.codexCliOverrides
                    });

                    const resumeCandidate = session.sessionId ?? null;
                    const forkCandidate = !resumeCandidate ? session.forkSessionId : null;
                    let threadId: string | null = null;

                    if (forkCandidate) {
                        try {
                            // Do not pass start-time overrides: native fork must inherit the source
                            // model, reasoning effort, permission policy, and conversation history.
                            const forkResponse = await appServerClient.forkThread({
                                threadId: forkCandidate
                            }, {
                                signal: this.abortController.signal
                            });
                            const forkRecord = asRecord(forkResponse);
                            const forkThread = forkRecord ? asRecord(forkRecord.thread) : null;
                            threadId = asString(forkThread?.id);
                            applyForkedThreadConfiguration(forkResponse);
                            if (!threadId) {
                                throw new Error('app-server thread/fork did not return thread.id');
                            }
                            logger.debug(`[Codex] Forked app-server thread ${forkCandidate} into ${threadId}`);
                        } catch (error) {
                            logger.warn(`[Codex] Failed to fork app-server thread ${forkCandidate}`, error);
                            const failureMessage = `Task failed: Codex conversation ${forkCandidate} could not be forked; no new conversation was created`;
                            sendTaskStatus(failureMessage, {
                                status: 'failed',
                                eventMessage: `Codex conversation ${forkCandidate} could not be forked; no new conversation was created`,
                                recoverable: false
                            });
                            pending = null;
                            continue;
                        }
                    } else if (resumeCandidate) {
                        try {
                            const resumeResponse = await appServerClient.resumeThread({
                                threadId: resumeCandidate,
                                ...threadParams
                            }, {
                                signal: this.abortController.signal
                            });
                            const resumeRecord = asRecord(resumeResponse);
                            const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                            threadId = asString(resumeThread?.id) ?? resumeCandidate;
                            applyResolvedModel(resumeRecord?.model);
                            logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                        } catch (error) {
                            logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate}; preserving old conversation boundary`, error);
                            const failureMessage = `Task failed: Codex conversation ${resumeCandidate} could not be resumed; no new conversation was created`;
                            sendTaskStatus(failureMessage, {
                                status: 'failed',
                                eventMessage: `Codex conversation ${resumeCandidate} could not be resumed; no new conversation was created`,
                                recoverable: false
                            });
                            pending = null;
                            continue;
                        }
                    }

                    if (!threadId) {
                        const threadResponse = await appServerClient.startThread(threadParams, {
                            signal: this.abortController.signal
                        });
                        const threadRecord = asRecord(threadResponse);
                        const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                        threadId = asString(thread?.id);
                        applyResolvedModel(threadRecord?.model);
                        if (!threadId) {
                            throw new Error('app-server thread/start did not return thread.id');
                        }
                    }

                    if (!threadId) {
                        throw new Error('app-server resume did not return thread.id');
                    }

                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                    hasThread = true;
                } else {
                    if (!this.currentThreadId) {
                        logger.debug('[Codex] Missing thread id; restarting app-server thread');
                        hasThread = false;
                        pending = message;
                        continue;
                    }
                }

                turnInFlight = true;
                allowAnonymousTerminalEvent = false;
                const mode = {
                    ...message.mode,
                    model: session.getModel() ?? message.mode.model
                };
                const shouldSendCollaborationMode = supportsTurnCollaborationMode
                    && Boolean(mode.collaborationMode);
                const buildParams = (suppressCollaborationMode: boolean) => buildTurnStartParams({
                    threadId: this.currentThreadId!,
                    message: message.message,
                    cwd: session.path,
                    mode,
                    cliOverrides: session.codexCliOverrides,
                    overrides: suppressCollaborationMode
                        ? { suppressCollaborationMode: true }
                        : undefined
                });
                if (
                    mode.collaborationMode === 'plan'
                    && !supportsTurnCollaborationMode
                ) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: 'Plan mode is not supported by this Codex runtime. Sent as a normal turn instead.'
                    });
                }
                let turnResponse: unknown;
                try {
                    turnResponse = await appServerClient.startTurn(buildParams(!shouldSendCollaborationMode), {
                        signal: this.abortController.signal
                    });
                } catch (error) {
                    if (shouldSendCollaborationMode && shouldRetryWithoutCollaborationMode(error)) {
                        supportsTurnCollaborationMode = false;
                        if (mode.collaborationMode === 'plan') {
                            session.sendSessionEvent({
                                type: 'message',
                                message: 'Plan mode is not supported by this Codex runtime. Sent as a normal turn instead.'
                            });
                        }
                        turnResponse = await appServerClient.startTurn(buildParams(true), {
                            signal: this.abortController.signal
                        });
                    } else {
                        throw error;
                    }
                }
                const turnRecord = asRecord(turnResponse);
                const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                const turnId = asString(turn?.id);
                if (turnInFlight) {
                    if (turnId) {
                        this.currentTurnId = turnId;
                    } else if (!this.currentTurnId) {
                        allowAnonymousTerminalEvent = true;
                    }
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                this.currentTurnId = null;

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    this.currentTurnId = null;
                    this.currentThreadId = null;
                    hasThread = false;
                }
            } finally {
                if (!turnInFlight) {
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appServerEventConverter.reset();
                    mcpTitleByCallId.clear();
                    toolStartedAtByCallId.clear();
                    pendingAgentToolInputByCallId.clear();
                    pendingAgentTracesByAgentId.clear();
                    cancelAllPendingThrottledAgentRunUpdates();
                    childAgentRuntimeById.clear();
                    session.onThinkingChange(false);
                    clearReadyAfterTurnTimer?.();
                    if (!suppressReadyAfterMessage) {
                        emitReadyIfIdle({
                            pending: pending ?? (recoveryInFlight ? activeMessage : null),
                            queueSize: () => session.queue.size(),
                            shouldExit: this.shouldExit,
                            sendReady
                        });
                    }
                }
                if (suppressReadyAfterMessage) {
                    suppressReadyForAdminCommand = false;
                }
                logActiveHandles('after-turn');
            }
        }

        takePendingSideSessionFork()?.reject(new Error('Codex session ended before the side session was created'));
        failPendingAgentStarts('spawn_agent did not return an agent id before the Codex session ended');
        cancelAllPendingThrottledAgentRunUpdates();
        markAllActiveSubagents('canceled', 'Session ended');
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        this.appServerClient.setStderrHandler(null);
        try {
            await this.appServerClient.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;
        this.activeChildTurns.clear();

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
