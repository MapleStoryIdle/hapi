import type { AgentTextBlock, ChatBlock, ToolCallBlock } from '@/chat/types'
import { getInputStringAny } from '@/lib/toolInputUtils'

const SKILL_NAME_RE = /(?:skill|技能)\s*[:：]?\s*[$`]?([A-Za-z][\w-]{1,50})`?/i
const USE_SKILL_RE = /(?:使用|用|using|use)\s+[$`]?([A-Za-z][\w-]{1,50})`?(?=\s*[:：,，。.]|\s|$)/i
const SKILL_FILE_PATH_RE = /(?:^|[\s'"`])[^\s'"`]*[\\/](?<skill>[A-Za-z][\w-]{1,50})[\\/]SKILL\.md(?=$|[\s'"`])/gi
const SKILL_READ_COMMAND_RE = /(?:^|[\s;'"|&()])(?:cat|sed|head|tail|less|more)\b/i
const IGNORED_SKILL_WORDS = new Set(['skill', 'tool', 'tools', 'function', 'mode', 'builtin'])
const SHELL_TOOL_NAMES = new Set(['Bash', 'CodexBash', 'shell_command', 'run_shell_command'])

function normalizeSkillName(value: string | null): string | null {
    const normalized = value?.trim().replace(/^[$`]+|[`]+$/g, '') ?? ''
    if (!normalized || IGNORED_SKILL_WORDS.has(normalized.toLowerCase())) return null
    return normalized
}

/**
 * Detects an agent's explicit announcement that it is using a named skill.
 * This intentionally does not treat an arbitrary mention of a SKILL.md file
 * as a skill invocation.
 */
export function detectExplicitSkillName(text: string): string | null {
    const namedSkill = normalizeSkillName(text.match(SKILL_NAME_RE)?.[1] ?? null)
    if (namedSkill) return namedSkill

    return normalizeSkillName(text.match(USE_SKILL_RE)?.[1] ?? null)
}

function getShellCommand(block: ToolCallBlock): string | null {
    if (!SHELL_TOOL_NAMES.has(block.tool.name)) return null
    return getInputStringAny(block.tool.input, ['command', 'cmd'])
}

function getReadSkillName(block: ToolCallBlock): string | null {
    const command = getShellCommand(block)
    if (!command || !SKILL_READ_COMMAND_RE.test(command)) return null

    for (const match of command.matchAll(SKILL_FILE_PATH_RE)) {
        const skill = normalizeSkillName(match.groups?.skill ?? null)
        if (skill) return skill
    }
    return null
}

function sameSkillName(left: string, right: string): boolean {
    return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}

function createSyntheticSkillBlock(source: ToolCallBlock, skill: string, description: string): ToolCallBlock {
    const id = `skill:${source.id}`
    const toolId = `skill:${source.tool.id}`

    return {
        kind: 'tool-call',
        id,
        localId: source.localId,
        createdAt: source.createdAt,
        invokedAt: source.invokedAt,
        durationMs: source.durationMs,
        usage: source.usage,
        model: source.model,
        meta: source.meta,
        children: source.children,
        tool: {
            id: toolId,
            name: 'Skill',
            state: source.tool.state,
            input: { skill },
            createdAt: source.tool.createdAt,
            startedAt: source.tool.startedAt,
            completedAt: source.tool.completedAt,
            durationMs: source.tool.durationMs,
            // Keep the agent's one-line reason visible on the card instead of
            // leaving it as a separate process message.
            description,
            // A successful shell read is an implementation detail; the Skill
            // view should present it as "Skill loaded" rather than expose the
            // entire SKILL.md payload. Preserve error output for diagnosis.
            result: source.tool.state === 'error' ? source.tool.result : null,
            permission: undefined,
        },
    }
}

/**
 * Codex loads a skill by reading its SKILL.md. The file body is internal prompt
 * material, not conversation content, so always collapse that read into the
 * same compact Skill card used by native events. When an adjacent announcement
 * names the same skill, fold that sentence into the card as its description.
 */
export function normalizeExplicitSkillUsage(blocks: ChatBlock[]): ChatBlock[] {
    const normalized: ChatBlock[] = []

    for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]!
        const next = blocks[index + 1]
        if (block.kind === 'agent-text' && next?.kind === 'tool-call') {
            const announcedSkill = detectExplicitSkillName(block.text)
            const readSkill = getReadSkillName(next)
            if (announcedSkill && readSkill && sameSkillName(announcedSkill, readSkill)) {
                normalized.push(createSyntheticSkillBlock(next, announcedSkill, block.text))
                index += 1
                continue
            }
        }

        if (block.kind === 'tool-call') {
            const readSkill = getReadSkillName(block)
            if (readSkill) {
                normalized.push(createSyntheticSkillBlock(
                    block,
                    readSkill,
                    block.tool.description ?? `Using ${readSkill}`
                ))
                continue
            }
        }

        normalized.push(block)
    }

    return normalized
}
