import {
    CODEX_REASONING_EFFORT_OPTIONS,
    DEFAULT_NEW_SESSION_AGENT,
    NEW_SESSION_AGENT_OPTIONS,
    OPENCODE_REASONING_EFFORT_OPTIONS,
    type AgentType,
    type NewSessionReasoningEffort
} from './types'

const AGENT_STORAGE_KEY = 'hapi:newSession:agent'
const YOLO_STORAGE_KEY = 'hapi:newSession:yolo'
const MODEL_STORAGE_PREFIX = 'hapi:newSession:model:'
const REASONING_EFFORT_STORAGE_PREFIX = 'hapi:newSession:reasoningEffort:'

export type DefaultNewSessionAgentConfig = {
    agent: AgentType
    model?: string
    modelReasoningEffort?: NewSessionReasoningEffort
    yolo: boolean
}

// New-session picker intentionally exposes only the primary local coding agents.
const VALID_AGENTS = NEW_SESSION_AGENT_OPTIONS

function isValidAgent(agent: string): agent is AgentType {
    return (VALID_AGENTS as readonly string[]).includes(agent)
}

function modelStorageKey(agent: AgentType): string {
    return `${MODEL_STORAGE_PREFIX}${agent}`
}

function reasoningEffortStorageKey(agent: AgentType): string {
    return `${REASONING_EFFORT_STORAGE_PREFIX}${agent}`
}

export function loadPreferredAgent(): AgentType {
    try {
        const stored = localStorage.getItem(AGENT_STORAGE_KEY)
        if (stored && isValidAgent(stored)) {
            return stored
        }
    } catch {
        // Ignore storage errors
    }
    return 'codex'
}

export function savePreferredAgent(agent: AgentType): void {
    try {
        localStorage.setItem(AGENT_STORAGE_KEY, agent)
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredModel(agent: AgentType): string {
    try {
        const stored = localStorage.getItem(modelStorageKey(agent))
        if (stored?.trim()) {
            return stored
        }
    } catch {
        // Ignore storage errors
    }
    return 'auto'
}

export function savePreferredModel(agent: AgentType, model: string): void {
    try {
        localStorage.setItem(modelStorageKey(agent), model)
    } catch {
        // Ignore storage errors
    }
}

function getReasoningEffortValues(agent: AgentType): readonly string[] {
    if (agent === 'opencode') {
        return OPENCODE_REASONING_EFFORT_OPTIONS.map((option) => option.value)
    }
    return CODEX_REASONING_EFFORT_OPTIONS.map((option) => option.value)
}

export function loadPreferredReasoningEffort(agent: AgentType): NewSessionReasoningEffort {
    try {
        const stored = localStorage.getItem(reasoningEffortStorageKey(agent))
        if (stored && getReasoningEffortValues(agent).includes(stored)) {
            return stored as NewSessionReasoningEffort
        }
    } catch {
        // Ignore storage errors
    }
    return 'default'
}

export function savePreferredReasoningEffort(agent: AgentType, effort: NewSessionReasoningEffort): void {
    try {
        localStorage.setItem(reasoningEffortStorageKey(agent), effort)
    } catch {
        // Ignore storage errors
    }
}

export function loadPreferredYoloMode(): boolean {
    try {
        return localStorage.getItem(YOLO_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function savePreferredYoloMode(enabled: boolean): void {
    try {
        localStorage.setItem(YOLO_STORAGE_KEY, enabled ? 'true' : 'false')
    } catch {
        // Ignore storage errors
    }
}

/**
 * Settings used by a one-tap session creation. Keep this aligned with the
 * default agent selected by the full new-session form.
 */
export function loadDefaultNewSessionAgentConfig(): DefaultNewSessionAgentConfig {
    const agent = DEFAULT_NEW_SESSION_AGENT
    const model = loadPreferredModel(agent)
    const modelReasoningEffort = loadPreferredReasoningEffort(agent)

    return {
        agent,
        model: model === 'auto' ? undefined : model,
        modelReasoningEffort: modelReasoningEffort === 'default' ? undefined : modelReasoningEffort,
        yolo: loadPreferredYoloMode()
    }
}
