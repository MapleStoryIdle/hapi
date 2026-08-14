/**
 * 会话引用辅助函数。
 *
 * HAPI 的 `/sessions/<id>` 是 Hub 路径，不是本地文件路径。该模块由
 * CLI、MCP 工具和各 Agent 的系统提示词共用，避免模型把引用误当成本地文件。
 */

/** 复制会话引用时追加的模型引导说明。 */
export const SESSION_REFERENCE_STEER_SUFFIX =
    ' HAPI hub peer - call inspect_peer with that session id; do not Grep/Glob/Read /sessions/ as a local file.'

/** `inspect_peer` 的模型侧工具说明。 */
export const INSPECT_PEER_TOOL_DESCRIPTION =
    'Read another HAPI session (metadata + recent message text) on the same hub/namespace. ' +
    'Use this when the user cites a peer via markdown [title](/sessions/<id>), Copy-reference prose, or a bare /sessions/<id>. ' +
    'Extract <id> and pass it as sessionIdPrefix. /sessions/<id> is a hub path, not a local filesystem path. ' +
    'Read-only: it never resumes the target session.'

/** `ping_peer` 的模型侧工具说明。 */
export const PING_PEER_TOOL_DESCRIPTION =
    'Send a message to another HAPI session on the same hub/namespace. ' +
    'Use this for a peer handoff or nudge. When the user cites [title](/sessions/<id>), Copy-reference prose, or a bare /sessions/<id>, ' +
    'extract <id> and pass it as sessionIdPrefix. /sessions/<id> is a hub path, not a local filesystem path. ' +
    'The target may be resumed before the message is delivered.'

/** `sessionIdPrefix` 参数的统一描述。 */
export const SESSION_ID_PREFIX_PARAM_DESCRIPTION =
    'Target HAPI session id or unique id prefix. Prefer the full UUID from [title](/sessions/<id>) or Copy-reference prose.'

function isPlausibleSessionId(id: string): boolean {
    // Hub session ID 没有点号；拒绝 `chat.tsx` 这类源代码路径尾部。
    return id.length > 0 && !id.includes('.')
}

const SESSION_PATH_IN_TEXT_RE =
    /(?:^|[^A-Za-z0-9_-])(?:\.?\/)?(?:[\w.-]+\/)*sessions\/([^/?#\s)\]"']+)/g

function decodeSessionIdSegment(raw: string): string | null {
    try {
        const id = decodeURIComponent(raw).replace(/[.,;:!?]+$/u, '')
        return isPlausibleSessionId(id) ? id : null
    } catch {
        return null
    }
}

/** 从 Markdown、复制文本或裸路径中提取去重后的会话 ID。 */
export function extractSessionCitationIds(text: string): string[] {
    if (!text) return []

    const seen = new Set<string>()
    const ids: string[] = []
    SESSION_PATH_IN_TEXT_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SESSION_PATH_IN_TEXT_RE.exec(text)) !== null) {
        const id = decodeSessionIdSegment(match[1] ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
    }
    return ids
}

function hasCanonicalCopyTail(match: RegExpExecArray, input: string): boolean {
    const tail = input.slice(match[0].length)
    return tail === '' || tail === `.${SESSION_REFERENCE_STEER_SUFFIX}`
}

/**
 * 规范化工具参数中的会话 ID。
 *
 * 如果粘贴内容含多个引用则拒绝猜测，避免把消息发到错误会话。
 */
export function normalizeSessionIdPrefix(raw: string): string {
    const trimmed = raw.trim()

    const titledCopy = /^See session "(?:\\.|[^"\\])*" \(([^)]+)\) for context/.exec(trimmed)
    if (titledCopy?.[1] && hasCanonicalCopyTail(titledCopy, trimmed)) {
        const ids = extractSessionCitationIds(titledCopy[1])
        return ids.length === 1 ? ids[0]! : ''
    }

    const untitledCopy = /^See HAPI session (\S+) for context/.exec(trimmed)
    if (untitledCopy?.[1] && hasCanonicalCopyTail(untitledCopy, trimmed)) {
        const ids = extractSessionCitationIds(untitledCopy[1])
        return ids.length === 1 ? ids[0]! : ''
    }

    if (!trimmed.includes('/sessions/')) return trimmed

    const ids = extractSessionCitationIds(trimmed)
    return ids.length === 1 ? ids[0]! : ''
}

export type SessionCitationSteerTools = {
    inspectTool: string
    pingTool: string
    listPeersTool?: string
}

/** 生成各 Agent 共用的、面向模型的会话引用操作说明。 */
export function buildSessionCitationSteerInstruction(tools: SessionCitationSteerTools): string {
    let text =
        `When the user cites another HAPI session as [title](/sessions/<id>), ` +
        `Copy-reference prose See session "…" (/sessions/<id>) for context, or a bare /sessions/<id>, extract that <id>. ` +
        `/sessions/<id> is a HAPI hub path, not a local filesystem path - do not Grep, Glob, or Read it as a file. ` +
        `Call "${tools.inspectTool}" with sessionIdPrefix=<id> to read metadata and recent messages; ` +
        `call "${tools.pingTool}" with sessionIdPrefix=<id> and a message to nudge or hand off. ` +
        `Prefer these over JWT+curl. Shell fallbacks: hapi inspect-peer <id> / hapi ping-peer <id> <message>.`

    if (tools.listPeersTool) {
        text +=
            ` To discover peers without a citation, call "${tools.listPeersTool}" ` +
            `(same hub/namespace). Shell fallback: hapi ping-peer --list.`
    }
    return text
}
