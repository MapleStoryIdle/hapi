import type { NormalizedMessage } from '@/chat/types'

/** Queued drafts do not start a turn; consumed prompts carry a persisted invocation time. */
export function getThinkingStartedAt(messages: readonly NormalizedMessage[]): number | null {
    const prompt = messages.findLast((message) => message.role === 'user' && !message.isSidechain
        && message.status !== 'queued' && message.status !== 'sending' && message.status !== 'failed')
    return typeof prompt?.invokedAt === 'number' && Number.isFinite(prompt.invokedAt) && prompt.invokedAt > 0
        ? prompt.invokedAt : null
}
