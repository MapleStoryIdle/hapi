import { z } from 'zod'

export const KANBAN_MOVABLE_LANES = ['pending', 'unviewed', 'pinned', 'recent'] as const
const laneId = z.union([z.enum(KANBAN_MOVABLE_LANES), z.string().regex(/^custom:[^\s]+$/).max(300)])
export const KanbanOrderInputSchema = z.object({
    revision: z.number().int().nonnegative(),
    order: z.array(laneId).max(1000),
    reset: z.boolean().optional()
}).strict().refine(value => new Set(value.order).size === value.order.length, 'Duplicate lanes')
export type KanbanOrderInput = z.infer<typeof KanbanOrderInputSchema>
export type KanbanOrder = { order: string[]; revision: number }

/** Include empty groups, discard deleted ones, and insert new groups before Recent. */
export function normalizeKanbanOrder(saved: readonly string[], groupIds: readonly string[]): string[] {
    const defaults = ['pending', 'unviewed', 'pinned', ...new Set(groupIds.map(id => `custom:${id}`)), 'recent']
    const allowed = new Set(defaults)
    const result = [...new Set(saved)].filter(id => allowed.has(id))
    if (!result.length) return defaults
    for (const id of defaults) {
        if (result.includes(id)) continue
        const recent = result.indexOf('recent')
        if (id.startsWith('custom:') && recent >= 0) result.splice(recent, 0, id)
        else result.push(id)
    }
    return result
}

/** Replace only the submitted slots, keeping hidden groups at their saved positions. */
export function mergeVisibleKanbanOrder(current: readonly string[], visible: readonly string[]): string[] {
    const allowed = new Set(current)
    const reordered = [...new Set(visible)].filter(id => allowed.has(id))
    const moved = new Set(reordered)
    let index = 0
    return current.map(id => moved.has(id) ? reordered[index++]! : id)
}

export function sortKanbanLanes<T extends { id: string }>(lanes: readonly T[], order: readonly string[]): T[] {
    const ranks = new Map(order.map((id, index) => [id, index]))
    const rank = (id: string) => id === 'processing' ? -1 : id === 'completed' ? Infinity : ranks.get(id) ?? order.length
    return [...lanes].sort((a, b) => rank(a.id) - rank(b.id))
}
