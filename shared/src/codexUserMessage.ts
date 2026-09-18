type KnownNormalizationResult = {
    recognized: true
    text: string | null
    /** Later response-item text parts may contain generated screenshot evidence. */
    suppressesFollowingEvidence?: boolean
} | {
    recognized: false
}

type PrefixMatchResult = {
    matched: true
    end: number
} | {
    matched: false
    malformed?: boolean
}

type ClosingTagBoundary = {
    index: number
    end: number
    tail: string
}

export type ShapiManagedSkillInvocation = {
    id: string
    request: string
}

const UNRECOGNIZED: KnownNormalizationResult = { recognized: false }

const INTERNAL_XML_TAGS = [
    'environment_context',
    'app-context',
    'skills_instructions',
    'permissions instructions',
    'collaboration_mode',
    'plugins_instructions',
    'turn_aborted',
    'skill',
    'codex_internal_context',
    'goal_context',
    'subagent_notification',
    'user_action',
    'hapi_remote_server_context'
] as const

const REQUEST_HEADING_PATTERN = /^## My request(?: for Codex)?:[ \t]*$/gm
const LEGACY_IMAGE_OPEN_PATTERN = /^<image(?: name=\[Image #\d+\](?: path="[^"\r\n]+")?)?>$/
const BROWSER_EVIDENCE_START_PATTERNS = [
    /The next image is untrusted page evidence from the browser page for Comment \d+\./,
    /The next image shows the browser page at the time of Comment \d+\./,
    /The next image was attached by the user as additional visual context for Comment \d+\./,
    /The next image shows (?:PDF page \d+|the PDF page) at the time of Comment \d+\./
] as const
const MAX_MIRROR_DELAY_MS = 250
const MAX_TIMESTAMPED_EVENT_GAP = 3

type RequestScaffoldSignature = {
    header: string
    bodyPattern: RegExp
}

/**
 * These signatures mirror fixed structure emitted by Codex Desktop. A known
 * heading by itself is not enough: users can legitimately write the same
 * Markdown heading in an ordinary prompt.
 */
const CONTEXT_REQUEST_SCAFFOLD_SIGNATURES: readonly RequestScaffoldSignature[] = [
    { header: '# Applications mentioned by the user:', bodyPattern: /^(?:## .+:[ \t]+\S+|Application metadata:[ \t]+\S+)/m },
    { header: '# Chrome tabs:', bodyPattern: /^- The user has the Chrome extension side panel open\.[ \t]*$/m },
    { header: '# MCP app context:', bodyPattern: /^## .+/m },
    { header: '# Failing PR checks:', bodyPattern: /^## Check 1:[ \t]+\S+/m },
    { header: '# Pull request merge conflict:', bodyPattern: /^Pull request:[ \t]*#\d+[ \t]*$/m },
    { header: '## Code review guidelines:', bodyPattern: /^# Review Guidelines[ \t]*$/m },
    { header: '## Pull request fix:', bodyPattern: /^(?:Repository|Pull request):[ \t]+\S+/m },
    { header: '## Pull request merge task:', bodyPattern: /^Repository:[ \t]+\S+/m },
    { header: '## Auto resolve merge:', bodyPattern: /^Repository:[ \t]+\S+/m },
    { header: '## Prior conversation with Codex:', bodyPattern: /^(?:## |Repository:|Thread:|User:|Assistant:)/m },
    { header: '## Referenced chats with Codex:', bodyPattern: /^(?:## |Chat |Thread:|User:|Assistant:)/m },
    { header: '## Referenced ChatGPT conversation:', bodyPattern: /^(?:## |Conversation:|User:|Assistant:)/m }
]

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

type UserMessageCarrier = {
    source: 'event_msg' | 'response_item'
    rawText: string
    timestamp: number | null
}

type PendingUserMessage = UserMessageCarrier & {
    ordinal: number
    visibleText: string
}

function getEventUserText(payload: Record<string, unknown>): string | null {
    for (const key of ['message', 'text', 'content']) {
        const value = payload[key]
        if (typeof value === 'string' && value.length > 0) return value
    }
    return null
}

function getResponseUserText(payload: Record<string, unknown>): string | null {
    if (!Array.isArray(payload.content)) {
        return typeof payload.content === 'string' ? payload.content : null
    }

    const parts: string[] = []
    for (const item of payload.content) {
        const record = asRecord(item)
        if ((record?.type === 'input_text' || record?.type === 'text' || record?.type === 'output_text')
            && typeof record.text === 'string') {
            parts.push(record.text)
        }
    }
    const text = parts.join('')
    return text || null
}

function getUserMessageCarrier(event: unknown): UserMessageCarrier | null {
    const record = asRecord(event)
    const payload = asRecord(record?.payload)
    if (!record || !payload) return null

    let source: UserMessageCarrier['source']
    let rawText: string | null
    if (record.type === 'event_msg' && payload.type === 'user_message') {
        source = 'event_msg'
        rawText = getEventUserText(payload)
    } else if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        source = 'response_item'
        rawText = getResponseUserText(payload)
    } else {
        return null
    }
    if (!rawText) return null

    const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    return {
        source,
        rawText,
        timestamp: Number.isFinite(timestamp) ? timestamp : null
    }
}

/** Pair only the two exact native carriers for one user turn. */
export function createCodexUserMessageMirrorDeduper(): {
    shouldSuppress: (event: unknown, visibleText: string) => boolean
    reset: () => void
} {
    let ordinal = 0
    let pending: PendingUserMessage | null = null

    return {
        shouldSuppress(event, visibleText) {
            ordinal += 1
            const carrier = getUserMessageCarrier(event)
            if (!carrier) return false

            const eventGap = pending ? ordinal - pending.ordinal : Number.POSITIVE_INFINITY
            const timestampsMatch = pending !== null && pending.timestamp !== null && carrier.timestamp !== null
                && Math.abs(carrier.timestamp - pending.timestamp) <= MAX_MIRROR_DELAY_MS
                && eventGap <= MAX_TIMESTAMPED_EVENT_GAP
            const untimestampedAdjacent = pending?.timestamp === null && carrier.timestamp === null && eventGap === 1
            const isMirror = pending !== null
                && pending.source !== carrier.source
                && pending.rawText === carrier.rawText
                && pending.visibleText === visibleText
                && (timestampsMatch || untimestampedAdjacent)

            if (isMirror) {
                pending = null
                return true
            }

            pending = { ...carrier, ordinal, visibleText }
            return false
        },
        reset() {
            pending = null
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getRequestHeadingMatches(value: string): Array<{ index: number; end: number }> {
    const matches: Array<{ index: number; end: number }> = []
    for (const match of value.matchAll(REQUEST_HEADING_PATTERN)) {
        if (match.index === undefined) continue
        matches.push({ index: match.index, end: match.index + match[0].length })
    }
    return matches
}

function getLineMatches(value: string, pattern: RegExp): Array<{ index: number; end: number; text: string }> {
    const matches: Array<{ index: number; end: number; text: string }> = []
    for (const match of value.matchAll(pattern)) {
        if (match.index === undefined) continue
        matches.push({ index: match.index, end: match.index + match[0].length, text: match[0] })
    }
    return matches
}

/**
 * Generated containers can wrap untrusted text that repeats their closing tag.
 * Always finish scanning and keep the last acceptable boundary.
 */
function findLastClosingTagBoundary(
    value: string,
    closingTag: string,
    startIndex: number,
    acceptsTail: (tail: string) => boolean = () => true
): ClosingTagBoundary | null {
    let boundary: ClosingTagBoundary | null = null
    let closingIndex = value.indexOf(closingTag, startIndex)
    while (closingIndex >= 0) {
        const end = closingIndex + closingTag.length
        const tail = value.slice(end).trim()
        if (acceptsTail(tail)) boundary = { index: closingIndex, end, tail }
        closingIndex = value.indexOf(closingTag, end)
    }
    return boundary
}

function resultAfterRequestHeading(value: string, match: { end: number }): KnownNormalizationResult {
    const request = value.slice(match.end).trim()
    return { recognized: true, text: request || null }
}

function normalizeRequestScaffold(value: string): KnownNormalizationResult {
    const firstLineEnd = value.search(/\r?\n/)
    const firstLine = (firstLineEnd < 0 ? value : value.slice(0, firstLineEnd)).trimEnd()
    const isFileScaffold = firstLine === '# Files mentioned by the user:'
        || firstLine === '# Files pasted by the user:'
    const contextSignature = CONTEXT_REQUEST_SCAFFOLD_SIGNATURES.find(({ header }) => firstLine === header)
    if (!isFileScaffold && !contextSignature) return UNRECOGNIZED

    const matches = getRequestHeadingMatches(value)
    if (matches.length === 0) return UNRECOGNIZED

    if (isFileScaffold) {
        // The first delimiter following a real file section is Codex-owned.
        // Any later identical heading belongs to the user's request.
        const requestMatch = matches.find((match) => {
            const body = value.slice(firstLineEnd < 0 ? value.length : firstLineEnd, match.index).trim()
            return getLineMatches(body, /^## .+:[ \t]+[^\r\n]+$/gm).length > 0
        })
        return requestMatch ? resultAfterRequestHeading(value, requestMatch) : UNRECOGNIZED
    }

    // Context can include untrusted Markdown. Using the final delimiter avoids
    // exposing that context if it contains a delimiter-shaped line itself.
    const requestMatch = matches[matches.length - 1]
    const scaffoldBody = value.slice(firstLineEnd < 0 ? value.length : firstLineEnd, requestMatch.index).trim()
    if (!scaffoldBody || !contextSignature?.bodyPattern.test(scaffoldBody)) return UNRECOGNIZED
    return resultAfterRequestHeading(value, requestMatch)
}

function normalizeLegacyBrowserScaffold(value: string): KnownNormalizationResult {
    if (!/^# In app browser:[ \t]*(?:\r?\n|$)/.test(value)) return UNRECOGNIZED
    const matches = getRequestHeadingMatches(value)
    const requestMatch = matches[matches.length - 1]
    return requestMatch ? resultAfterRequestHeading(value, requestMatch) : UNRECOGNIZED
}

function normalizeXmlBrowserScaffold(value: string): KnownNormalizationResult {
    const opening = /^<in-app-browser-context(?:[ \t]+[^<>\r\n]+)?>/.exec(value)
    if (!opening) return UNRECOGNIZED

    const closingTag = '</in-app-browser-context>'
    const boundary = findLastClosingTagBoundary(
        value,
        closingTag,
        opening[0].length,
        (tail) => !tail || getRequestHeadingMatches(tail)[0]?.index === 0
    )
    if (!boundary) return UNRECOGNIZED

    const { tail } = boundary
    if (!tail) return { recognized: true, text: null }
    const requestMatch = getRequestHeadingMatches(tail)[0]
    if (!requestMatch) return UNRECOGNIZED
    return resultAfterRequestHeading(tail, requestMatch)
}

function findGeneratedEvidenceIndex(value: string): number {
    const indexes = BROWSER_EVIDENCE_START_PATTERNS
        .map((pattern) => pattern.exec(value)?.index)
        .filter((index): index is number => index !== undefined)
    return indexes.length > 0 ? Math.min(...indexes) : -1
}

function extractBrowserComments(commentBlock: string): string[] | null {
    const sectionPattern = /^## (?:(?:User )?Comment|Requested annotation) \d+[ \t]*$/gm
    const sections = getLineMatches(commentBlock, sectionPattern)
    const allSecondLevelHeadings = getLineMatches(commentBlock, /^## .+[ \t]*$/gm)
    if (sections.length === 0 || sections.length !== allSecondLevelHeadings.length) return null
    if (commentBlock.slice(0, sections[0].index).trim()) return null

    const visibleParts: string[] = []
    for (let index = 0; index < sections.length; index += 1) {
        const section = sections[index]
        const sectionEnd = sections[index + 1]?.index ?? commentBlock.length
        const body = commentBlock.slice(section.end, sectionEnd).trim()
        const isRequestedAnnotation = /^## Requested annotation /.test(section.text)
        const fieldName = isRequestedAnnotation ? 'Requested changes' : 'Comment'
        const fields = getLineMatches(
            body,
            new RegExp(`^${escapeRegExp(fieldName)}:[ \\t]*(?:\\r?\\n|$)`, 'gm')
        )
        if (fields.length !== 1) return null

        let userText = body.slice(fields[0].end)
        if (isRequestedAnnotation) {
            const generatedSuffixes = [
                /^Style provenance:[ \t]*$/m,
                /^Apply each annotation to the source code or design tokens that own the current UI\./m,
                /^Saved marker screenshot:/m,
                /^Annotated (?:PDF )?screenshot:/m
            ]
                .map((pattern) => pattern.exec(userText)?.index)
                .filter((position): position is number => position !== undefined)
            if (generatedSuffixes.length > 0) userText = userText.slice(0, Math.min(...generatedSuffixes))
        }
        const normalizedUserText = userText.trim()
        if (normalizedUserText) visibleParts.push(normalizedUserText)
    }
    return visibleParts
}

/**
 * Browser annotations contain page URLs, selectors, and untrusted DOM text.
 * Only the explicit comment fields and final request are user-authored.
 */
function normalizeBrowserCommentsScaffold(value: string): KnownNormalizationResult {
    if (!/^# Browser comments:[ \t]*(?:\r?\n|$)/.test(value)) return UNRECOGNIZED

    const scaffold = value

    const xmlMarkers = getLineMatches(scaffold, /^<in-app-browser-context(?:[ \t]+[^<>\r\n]+)?>$/gm)
    const xmlMarker = [...xmlMarkers].reverse().find((marker) => (
        normalizeXmlBrowserScaffold(scaffold.slice(marker.index).trim()).recognized
    ))
    const legacyMarkers = getLineMatches(scaffold, /^# In app browser:[ \t]*$/gm)
    const legacyMarker = xmlMarker ? null : [...legacyMarkers].reverse().find((marker) => (
        getRequestHeadingMatches(scaffold.slice(marker.index)).length > 0
    ))
    const browserMarker = xmlMarker ?? legacyMarker
    if (!browserMarker) return UNRECOGNIZED

    const browserTail = scaffold.slice(browserMarker.index).trim()
    const request = xmlMarker
        ? normalizeXmlBrowserScaffold(browserTail)
        : (() => {
            const matches = getRequestHeadingMatches(browserTail)
            const requestMatch = matches[matches.length - 1]
            return requestMatch ? resultAfterRequestHeading(browserTail, requestMatch) : UNRECOGNIZED
        })()
    if (!request.recognized) return UNRECOGNIZED

    const commentBlock = scaffold.slice(scaffold.indexOf('\n') + 1, browserMarker.index).trim()
    // Ambiguous untrusted page evidence must never make the whole known outer
    // wrapper fail open. In that case keep only the final user request.
    const visibleParts = extractBrowserComments(commentBlock) ?? []
    if (request.text) {
        // `event_msg.user_message` concatenates generated screenshot evidence
        // after the request with no delimiter. Search only inside the already
        // isolated request so page text cannot make the outer parser fail open.
        const evidenceIndex = findGeneratedEvidenceIndex(request.text)
        const visibleRequest = (evidenceIndex < 0 ? request.text : request.text.slice(0, evidenceIndex)).trim()
        if (visibleRequest) visibleParts.push(visibleRequest)
    }

    const text = visibleParts.join('\n\n').trim()
    return { recognized: true, text: text || null, suppressesFollowingEvidence: true }
}

function normalizeResponseAnnotationsScaffold(value: string): KnownNormalizationResult {
    if (!value.startsWith('# Response annotations:')) return UNRECOGNIZED
    const openingTag = '<response-annotations>'
    const closingTag = '</response-annotations>'
    const openingIndex = value.indexOf(openingTag)
    if (openingIndex < 0) return UNRECOGNIZED

    const boundary = findLastClosingTagBoundary(
        value,
        closingTag,
        openingIndex + openingTag.length,
        (tail) => getRequestHeadingMatches(tail)[0]?.index === 0
    )
    if (!boundary) return UNRECOGNIZED
    const requestMatch = getRequestHeadingMatches(boundary.tail)[0]
    return requestMatch ? resultAfterRequestHeading(boundary.tail, requestMatch) : UNRECOGNIZED
}

function normalizeCommentOrSelectionScaffold(value: string): KnownNormalizationResult {
    const signatures = [
        { header: '# Diff comments:', pattern: /^## (?:(?:User )?Comment|Requested annotation) 1(?:[ \t]|$)/m },
        { header: '# Selected text:', pattern: /^## Selection 1(?:[ \t]|$)/m }
    ] as const
    const signature = signatures.find(({ header }) => value.startsWith(`${header}\n`) || value === header)
    if (!signature) return UNRECOGNIZED

    const matches = getRequestHeadingMatches(value)
    const requestMatch = matches[matches.length - 1]
    const body = requestMatch ? value.slice(signature.header.length, requestMatch.index) : ''
    if (!requestMatch || !signature.pattern.test(body)) return UNRECOGNIZED
    return resultAfterRequestHeading(value, requestMatch)
}

function decodeXmlText(value: string): string {
    return value
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&amp;', '&')
}

function normalizeDelegationScaffold(value: string): KnownNormalizationResult {
    const tag = value.startsWith('<codex_delegation>')
        ? 'codex_delegation'
        : value.startsWith('<realtime_delegation>')
            ? 'realtime_delegation'
            : null
    if (!tag || !value.endsWith(`</${tag}>`)) return UNRECOGNIZED
    if (tag === 'codex_delegation' && !/<source_thread_id>[\s\S]*?<\/source_thread_id>/.test(value)) {
        return UNRECOGNIZED
    }
    const input = /<input>\s*([\s\S]*?)\s*<\/input>/i.exec(value)?.[1]
    return input === undefined
        ? UNRECOGNIZED
        : { recognized: true, text: decodeXmlText(input).trim() || null }
}

function normalizeAppshotScaffold(value: string): KnownNormalizationResult {
    const openingPattern = /<appshot\b([^<>\r\n]*)>/g
    let opening: RegExpExecArray | null = null
    for (const match of value.matchAll(openingPattern)) {
        const attributes = match[1]
        if (/\bapp="[^"]+"/.test(attributes) && /\bbundle-identifier="[^"]+"/.test(attributes)) {
            opening = match
            break
        }
    }
    if (!opening || opening.index === undefined) return UNRECOGNIZED

    // App accessibility text is untrusted and may itself contain a literal
    // `</appshot>`. The last closing tag is the only privacy-safe boundary for
    // this flattened carrier; an earlier match could expose the rest of the
    // private accessibility tree.
    const closingTag = '</appshot>'
    const boundary = findLastClosingTagBoundary(value, closingTag, opening.index + opening[0].length)
    if (!boundary) return UNRECOGNIZED

    const remainder = [
        value.slice(0, opening.index),
        value.slice(boundary.end)
    ].join('').trim()
    if (!remainder) return { recognized: true, text: null }

    const nested = normalizeKnownScaffold(remainder)
    return nested.recognized ? nested : { recognized: true, text: remainder }
}

/**
 * Recover the user-authored portion of a complete managed-skill wrapper for
 * a local display surface. The wrapper body is deliberately never returned.
 */
export function parseShapiManagedSkillInvocation(value: string): ShapiManagedSkillInvocation | null {
    const normalized = value.trim()
    const opening = /^<shapi-managed-skill(-ref)? id="([a-z][a-z0-9-]{0,63})" version="[^"<>\r\n]+">/.exec(normalized)
    if (!opening) return null

    const closingTag = opening[1] ? '</shapi-managed-skill-ref>' : '</shapi-managed-skill>'
    const boundary = findLastClosingTagBoundary(
        normalized,
        closingTag,
        opening[0].length,
        tail => /^User request:[ \t]*(?:\r?\n|$)/.test(tail)
    )
    if (!boundary) return null
    const heading = /^User request:[ \t]*(?:\r?\n|$)/.exec(boundary.tail)
    if (!heading) return null
    return {
        id: opening[2],
        request: boundary.tail.slice(heading[0].length).trim()
    }
}

function normalizeShapiManagedSkillScaffold(value: string): KnownNormalizationResult {
    if (!parseShapiManagedSkillInvocation(value)) return UNRECOGNIZED

    // The Hub already persisted the original `$skill request`. This record is
    // only Codex's expanded mirror; forwarding it would duplicate the user
    // turn and expose internal managed instructions.
    return { recognized: true, text: null }
}

function normalizeKnownScaffold(value: string): KnownNormalizationResult {
    return [
        normalizeShapiManagedSkillScaffold,
        normalizeBrowserCommentsScaffold,
        normalizeResponseAnnotationsScaffold,
        normalizeDelegationScaffold,
        normalizeRequestScaffold,
        normalizeCommentOrSelectionScaffold,
        normalizeXmlBrowserScaffold,
        normalizeLegacyBrowserScaffold,
        normalizeAppshotScaffold
    ].reduce<KnownNormalizationResult>((result, normalize) => (
        result.recognized ? result : normalize(value)
    ), UNRECOGNIZED)
}

function matchInternalXmlPrefix(value: string, tag: string): PrefixMatchResult {
    const escapedTag = escapeRegExp(tag)
    const openingPattern = tag.includes(' ')
        ? new RegExp(`^<${escapedTag}>`)
        : new RegExp(`^<${escapedTag}(?:[ \\t]+[^<>\\r\\n]+)?>`)
    const opening = openingPattern.exec(value)
    if (!opening) {
        return value.startsWith(`<${tag}`) ? { matched: false, malformed: true } : { matched: false }
    }

    const closingTag = `</${tag}>`
    const boundary = findLastClosingTagBoundary(value, closingTag, opening[0].length)
    if (!boundary) return { matched: false, malformed: true }
    return { matched: true, end: boundary.end }
}

function matchAgentsInstructionsPrefix(value: string): PrefixMatchResult {
    const header = /^# AGENTS\.md instructions(?: for [^\r\n]+)?[ \t]*(?:\r?\n|$)/.exec(value)
    if (!header) {
        return value.startsWith('# AGENTS.md instructions')
            ? { matched: false, malformed: true }
            : { matched: false }
    }

    const body = value.slice(header[0].length).trimStart()
    // Older Codex versions used the reserved header without the XML envelope.
    // With no reliable inner boundary, the complete content part is synthetic.
    if (!body.startsWith('<INSTRUCTIONS>')) return { matched: true, end: value.length }
    const closingTag = '</INSTRUCTIONS>'
    const boundary = findLastClosingTagBoundary(body, closingTag, '<INSTRUCTIONS>'.length)
    if (!boundary) return { matched: false, malformed: true }

    const bodyOffset = value.length - body.length
    return { matched: true, end: bodyOffset + boundary.end }
}

function stripInternalPrefixes(value: string): KnownNormalizationResult {
    let remainder = value
    let removed = false

    // One legacy remote-server bridge prefixed its synthetic context with the
    // transcript speaker index before writing the same well-formed wrapper.
    const legacyRemotePrefix = /^\[\d+\] user: (?=<hapi_remote_server_context>)/.exec(remainder)
    if (legacyRemotePrefix) {
        removed = true
        remainder = remainder.slice(legacyRemotePrefix[0].length)
    }

    while (remainder) {
        const agents = matchAgentsInstructionsPrefix(remainder)
        if (!agents.matched && agents.malformed) return UNRECOGNIZED
        if (agents.matched) {
            removed = true
            remainder = remainder.slice(agents.end).trimStart()
            continue
        }

        let matchedTag = false
        for (const tag of INTERNAL_XML_TAGS) {
            const match = matchInternalXmlPrefix(remainder, tag)
            if (!match.matched && match.malformed) return UNRECOGNIZED
            if (!match.matched) continue
            removed = true
            matchedTag = true
            remainder = remainder.slice(match.end).trimStart()
            break
        }
        if (!matchedTag) break
    }

    if (!removed) return UNRECOGNIZED
    if (!remainder.trim()) return { recognized: true, text: null }

    const nestedScaffold = normalizeKnownScaffold(remainder.trim())
    return nestedScaffold.recognized
        ? nestedScaffold
        : { recognized: true, text: remainder.trim() }
}

function isLegacyImageMarker(value: string): boolean {
    return value === '</image>' || LEGACY_IMAGE_OPEN_PATTERN.test(value)
}

function isGeneratedBrowserEvidence(value: string): boolean {
    return BROWSER_EVIDENCE_START_PATTERNS.some((pattern) => pattern.test(value))
}

function normalizeCodexUserMessageTextResult(value: string): KnownNormalizationResult {
    const normalized = value.trim().replace(/\r\n/g, '\n')
    if (!normalized) return { recognized: true, text: null }
    if (isLegacyImageMarker(normalized)) return { recognized: true, text: null }

    const scaffold = normalizeKnownScaffold(normalized)
    if (scaffold.recognized) return scaffold

    return stripInternalPrefixes(normalized)
}

/**
 * Remove Codex-owned prompt scaffolding while retaining the actual user text.
 * Unknown or malformed formats deliberately pass through unchanged.
 */
export function normalizeCodexUserMessageText(value: string): string | null {
    const normalized = value.trim()
    if (!normalized) return null
    const result = normalizeCodexUserMessageTextResult(normalized)
    return result.recognized ? result.text : normalized
}

function getCodexUserTextParts(value: unknown): string[] {
    if (typeof value === 'string') return [value]
    if (Array.isArray(value)) return value.flatMap(getCodexUserTextParts)

    const record = asRecord(value)
    if (!record) return []
    if (record.type !== 'input_text' && record.type !== 'text' && record.type !== 'output_text') return []
    return typeof record.text === 'string' ? [record.text] : []
}

/** Normalize either a flattened event_msg string or response_item content. */
export function normalizeCodexUserMessageContent(value: unknown): string | null {
    const visibleParts: string[] = []
    let suppressGeneratedEvidence = false
    for (const rawPart of getCodexUserTextParts(value)) {
        const normalized = rawPart.trim()
        if (!normalized) continue
        if (suppressGeneratedEvidence && isGeneratedBrowserEvidence(normalized)) continue

        const result = normalizeCodexUserMessageTextResult(normalized)
        if (result.recognized) {
            suppressGeneratedEvidence ||= result.suppressesFollowingEvidence === true
            if (result.text) visibleParts.push(result.text)
            continue
        }
        visibleParts.push(normalized)
    }
    const text = visibleParts.join('\n\n').trim()
    return text || null
}
