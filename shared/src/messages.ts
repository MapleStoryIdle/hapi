import { isObject } from './utils'

type RoleWrappedRecord = {
    role: string
    content: unknown
    meta?: unknown
}

const VISIBLE_CLAUDE_SYSTEM_SUBTYPES = new Set([
    'api_error',
    'turn_duration',
    'microcompact_boundary',
    'compact_boundary'
])

const AUTOMATION_HEARTBEAT_PATTERN = /^<heartbeat(?:\s[^>]*)?>\s*<automation_id>([\s\S]*?)<\/automation_id>\s*<decision>([\s\S]*?)<\/decision>\s*<message>([\s\S]*?)<\/message>\s*<\/heartbeat>$/i

export type AutomationHeartbeat = {
    automationId: string
    decision: string
    message: string
}

function extractTextMessageContent(value: unknown): string | null {
    if (typeof value === 'string') return value
    if (isObject(value) && value.type === 'text' && typeof value.text === 'string') return value.text
    if (!Array.isArray(value)) return null

    const blocks = value.map((block) => (
        isObject(block) && block.type === 'text' && typeof block.text === 'string'
            ? block.text
            : null
    ))
    return blocks.every((block) => block !== null) ? blocks.join('\n') : null
}

/**
 * Parses an automation heartbeat injected into a transcript so it can be
 * forwarded normally while the client renders it as a compact status card.
 */
export function parseAutomationHeartbeatMessageContent(value: unknown): AutomationHeartbeat | null {
    const text = extractTextMessageContent(value)
    if (text === null) return null

    const match = text.trim().match(AUTOMATION_HEARTBEAT_PATTERN)
    if (!match) return null

    const automationId = match[1].trim()
    const decision = match[2].trim()
    const message = match[3].trim()
    if (!automationId || !decision || !message) return null

    return { automationId, decision, message }
}

export function isAutomationHeartbeatMessageContent(value: unknown): boolean {
    return parseAutomationHeartbeatMessageContent(value) !== null
}

export function isRoleWrappedRecord(value: unknown): value is RoleWrappedRecord {
    if (!isObject(value)) return false
    return typeof value.role === 'string' && 'content' in value
}

export function unwrapRoleWrappedRecordEnvelope(value: unknown): RoleWrappedRecord | null {
    if (isRoleWrappedRecord(value)) return value
    if (!isObject(value)) return null

    const direct = value.message
    if (isRoleWrappedRecord(direct)) return direct

    const data = value.data
    if (isObject(data) && isRoleWrappedRecord(data.message)) return data.message as RoleWrappedRecord

    const payload = value.payload
    if (isObject(payload) && isRoleWrappedRecord(payload.message)) return payload.message as RoleWrappedRecord

    return null
}

export function isClaudeChatVisibleSystemSubtype(subtype: unknown): subtype is string {
    return typeof subtype === 'string' && VISIBLE_CLAUDE_SYSTEM_SUBTYPES.has(subtype)
}

export function isClaudeChatVisibleMessage(message: { type: unknown; subtype?: unknown }): boolean {
    if (message.type === 'rate_limit_event') {
        return false
    }

    if (message.type !== 'system') {
        return true
    }

    return isClaudeChatVisibleSystemSubtype(message.subtype)
}

export function isRedundantGoalStatusMessageText(value: unknown): boolean {
    if (typeof value !== 'string') return false
    const message = value.trim()
    return message === 'Goal cleared'
        || /^Goal (active|paused|complete|limited by budget)(?:$|\s+·\s+)/.test(message)
}

export function isRedundantGoalStatusEventContent(value: unknown): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(value)
    if (record?.role !== 'agent') return false

    const eventContent = record.content
    if (!isObject(eventContent) || eventContent.type !== 'event') return false

    const data = isObject(eventContent.data) ? eventContent.data : null
    if (!data || data.type !== 'message') return false

    return isRedundantGoalStatusMessageText(data.message)
}

/**
 * 尽力从已存储的 Agent 消息中提取对人可见的纯文本。
 * 工具调用、推理和其他噪声会返回 null，供 A2A 的 inspect/work graph 过滤。
 */
export function extractAssistantPlainText(content: unknown): string | null {
    if (!isObject(content)) return null

    if (content.type === 'codex') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'message') return null
        return typeof data.message === 'string' && data.message.trim()
            ? data.message
            : null
    }

    if (content.type === 'output') {
        const data = isObject(content.data) ? content.data : null
        if (!data || data.type !== 'assistant') return null
        const message = isObject(data.message) ? data.message : null
        const blocks = Array.isArray(message?.content) ? message.content : null
        if (!blocks) return null

        const text = blocks.flatMap((block) => {
            if (!isObject(block) || block.type !== 'text' || typeof block.text !== 'string') return []
            return [block.text]
        }).join('\n')
        return text.trim() ? text : null
    }

    return null
}

export type { RoleWrappedRecord }
