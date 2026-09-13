import { z } from 'zod'
import { SessionGroupSourceSchema, type SessionGroupSource } from './sessionGroups'

const labelText = z.string().trim().min(1).refine(value => {
    const units = Array.from(value).reduce((total, character) => (
        total + (/\p{Script=Han}/u.test(character) ? 2 : 1)
    ), 0)
    return units <= 16
}, 'Label must be at most 8 Chinese characters or 16 other characters')

export const SessionLabelInputSchema = z.object({
    source: SessionGroupSourceSchema,
    label: labelText.nullable()
}).strict()

export type SessionLabelSource = SessionGroupSource
export type SessionLabelAssignment = { source: SessionLabelSource; label: string }
export type SessionLabelsResponse = { labels: SessionLabelAssignment[] }
