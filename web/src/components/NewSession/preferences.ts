import { NEW_SESSION_AGENT_OPTIONS, type AgentType } from './types'

const AGENT_STORAGE_KEY = 'hapi:newSession:agent'
const YOLO_STORAGE_KEY = 'hapi:newSession:yolo'

// New-session picker intentionally exposes only the primary local coding agents.
const VALID_AGENTS = NEW_SESSION_AGENT_OPTIONS

export function loadPreferredAgent(): AgentType {
    try {
        const stored = localStorage.getItem(AGENT_STORAGE_KEY)
        if (stored && (VALID_AGENTS as readonly string[]).includes(stored)) {
            return stored as AgentType
        }
    } catch {
        // Ignore storage errors
    }
    return 'claude'
}

export function savePreferredAgent(agent: AgentType): void {
    try {
        localStorage.setItem(AGENT_STORAGE_KEY, agent)
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
