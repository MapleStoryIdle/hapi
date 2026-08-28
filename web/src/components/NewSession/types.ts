import {
    CLAUDE_EFFORT_LABELS,
    CLAUDE_EFFORT_LEVELS,
    CLAUDE_MODEL_LABELS,
    CLAUDE_MODEL_PRESETS,
    GEMINI_MODEL_LABELS,
    GEMINI_MODEL_PRESETS
} from '@hapi/protocol'
import type { AgentFlavor, ClaudeEffortLevel } from '@hapi/protocol'

export type AgentType = AgentFlavor
export type SessionType = 'simple' | 'worktree'
export type CodexReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type NewSessionReasoningEffort = CodexReasoningEffort
export type ClaudeEffort = 'auto' | ClaudeEffortLevel

export const NEW_SESSION_AGENT_OPTIONS = ['claude', 'codex'] as const satisfies readonly AgentType[]
export const DEFAULT_NEW_SESSION_AGENT = 'codex' satisfies AgentType

function modelPresetOptions<TModel extends string>(
    presets: readonly TModel[],
    labels: Record<TModel, string>
): { value: string; label: string }[] {
    return presets.map(model => ({ value: model, label: labels[model] }))
}

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    claude: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(CLAUDE_MODEL_PRESETS, CLAUDE_MODEL_LABELS),
    ],
    codex: [
        { value: 'auto', label: 'Default' },
    ],
    cursor: [],
    kimi: [
        { value: 'auto', label: 'Default' },
    ],
    gemini: [
        { value: 'auto', label: 'Default' },
        ...modelPresetOptions(GEMINI_MODEL_PRESETS, GEMINI_MODEL_LABELS),
    ],
    opencode: [],
    pi: [],
}

export const CODEX_REASONING_EFFORT_OPTIONS: { value: CodexReasoningEffort; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
    { value: 'max', label: 'Max' },
    { value: 'ultra', label: 'Ultra' },
]

export const OPENCODE_REASONING_EFFORT_OPTIONS: { value: NewSessionReasoningEffort; label: string }[] = [
    { value: 'default', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'max', label: 'Max' },
]

export const CLAUDE_EFFORT_OPTIONS: { value: ClaudeEffort; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    ...CLAUDE_EFFORT_LEVELS.map((value) => ({ value, label: CLAUDE_EFFORT_LABELS[value] })),
]
