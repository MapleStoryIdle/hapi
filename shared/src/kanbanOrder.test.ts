import { describe, expect, it } from 'bun:test'
import { KanbanOrderInputSchema, mergeVisibleKanbanOrder, normalizeKanbanOrder, sortKanbanLanes } from './kanbanOrder'

describe('Kanban section order', () => {
    it('preserves hidden slots when only visible sections move', () => {
        const saved = ['pending', 'custom:empty', 'unviewed', 'pinned', 'recent']
        expect(mergeVisibleKanbanOrder(saved, ['recent', 'pinned', 'pending', 'unviewed'])).toEqual(['recent', 'custom:empty', 'pinned', 'pending', 'unviewed'])
    })
    it('removes deleted groups, inserts new groups before Recent, and keeps renamed IDs', () => {
        expect(normalizeKanbanOrder(['pinned', 'custom:old', 'recent', 'custom:kept', 'pending', 'unviewed'], ['kept', 'new']))
            .toEqual(['pinned', 'custom:new', 'recent', 'custom:kept', 'pending', 'unviewed'])
        expect(normalizeKanbanOrder(['recent', 'custom:old', 'pending', 'unviewed', 'pinned'], [])).toEqual(['recent', 'pending', 'unviewed', 'pinned'])
    })
    it('never moves Thinking or date sections regardless of saved input', () => {
        const lanes = ['completed', 'pending', 'processing', 'recent'].map(id => ({ id }))
        expect(sortKanbanLanes(lanes, ['recent', 'pending']).map(lane => lane.id)).toEqual(['processing', 'recent', 'pending', 'completed'])
        for (const order of [['processing'], ['completed'], ['date:today'], ['recent', 'recent']]) {
            expect(KanbanOrderInputSchema.safeParse({ order, revision: 0 }).success).toBe(false)
        }
    })
})
