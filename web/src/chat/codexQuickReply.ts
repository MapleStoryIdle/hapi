import type { NormalizedMessage } from '@/chat/types'

export type CodexQuickReplyPrompt = {
    messageId: string
}

const CHINESE_CONFIRMATION_PATTERNS = [
    /(?:请|麻烦|需要|等待).{0,8}(?:确认|同意|批准|授权|允许)/,
    /(?:是否|能否|可否|要不要|要我|需不需要|可以).{0,20}(?:确认|同意|批准|授权|允许|继续|执行|开始|进行|部署|提交|应用|删除|重启|覆盖|修改)/,
    /(?:确认|同意|批准|授权|允许).{0,20}(?:吗|？|\?)/
] as const

const ENGLISH_CONFIRMATION_PATTERNS = [
    /(?:^|[.!?]\s+)(?:please\s+)?(?:confirm|approve|authorize|authorise|allow|consent)\b/i,
    /\b(?:can|could|would|will|do|did|are|is)\s+(?:you|we|i)\s+(?:please\s+)?(?:confirm|approve|authorize|authorise|allow|consent)\b/i,
    /\b(?:would you like|do you want|shall i|may i|can i|should i|is it (?:okay|ok)(?:\s+(?:if|to))?)\b.{0,80}\b(?:agree|confirm|approve|authorize|authorise|allow|consent|continue|proceed|execute|run|apply|deploy|submit|delete|restart|overwrite)\b/i,
    /\b(?:need|awaiting|waiting for)\s+(?:your\s+)?(?:confirmation|approval|consent)\b/i
] as const

function getAgentText(message: Extract<NormalizedMessage, { role: 'agent' }>): string {
    return message.content
        .filter((content) => content.type === 'text')
        .map((content) => content.text)
        .join('\n')
}

/**
 * A lightweight, intentionally conservative heuristic for plain-text Codex
 * questions. Structured permissions keep using their own approval controls;
 * this only recognizes a normal chat reply that asks for consent to continue.
 */
export function isCodexConfirmationPrompt(text: string): boolean {
    const plainText = text
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(-1_200)

    if (plainText.length === 0) {
        return false
    }

    return CHINESE_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(plainText))
        || ENGLISH_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(plainText))
}

/**
 * Returns the latest unanswered normal agent question. A later user message
 * clears the shortcut, including an optimistic message still waiting to be
 * delivered to Codex.
 */
export function getPendingCodexQuickReplyPrompt(
    messages: readonly NormalizedMessage[],
): CodexQuickReplyPrompt | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (message.isSidechain) {
            continue
        }
        if (message.role === 'user') {
            return null
        }
        if (message.role !== 'agent') {
            continue
        }

        const text = getAgentText(message)
        if (text.length === 0) {
            continue
        }

        return isCodexConfirmationPrompt(text)
            ? { messageId: message.id }
            : null
    }

    return null
}
