import { z } from 'zod'
import { SessionGroupSourceSchema } from './sessionGroups'

export const SessionPinInputSchema = z.object({
    source: SessionGroupSourceSchema,
    pinned: z.boolean()
}).strict()

export const SessionPinMigrationSchema = z.object({
    sources: z.array(SessionGroupSourceSchema).max(500)
}).strict()

export type SessionPinSource = z.infer<typeof SessionGroupSourceSchema>
export type SessionPin = z.infer<typeof SessionPinInputSchema>
export type SessionPinsResponse = { pins: SessionPin[] }
