import { z } from 'zod'

const identifier = z.string().trim().min(1).max(256)

export const SessionGroupSourceSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('managed'), sessionId: identifier }).strict(),
    z.object({ type: z.literal('native-codex'), machineId: identifier, codexSessionId: identifier }).strict()
])

export const SessionGroupInputSchema = z.object({
    name: z.string().trim().min(1).max(80),
    emoji: z.string().trim().min(1).max(32)
}).strict()

export const SessionGroupUpdateSchema = SessionGroupInputSchema.partial().refine(
    value => value.name !== undefined || value.emoji !== undefined,
    'Provide a name or emoji'
)

export const SessionGroupAssignmentInputSchema = z.object({
    source: SessionGroupSourceSchema,
    groupId: identifier.nullable()
}).strict()

export type SessionGroupSource = z.infer<typeof SessionGroupSourceSchema>
export type SessionGroupInput = z.infer<typeof SessionGroupInputSchema>
export type SessionGroup = SessionGroupInput & { id: string }
export type SessionGroupAssignment = { source: SessionGroupSource; groupId: string }
export type SessionGroupsResponse = { groups: SessionGroup[]; assignments: SessionGroupAssignment[] }
