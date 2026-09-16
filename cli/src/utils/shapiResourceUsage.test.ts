import { describe, expect, it } from 'vitest'
import { parseUnixProcessTable, selectManagedProcessRows, summarizeManagedProcessRows } from './shapiResourceUsage'

describe('SHAPI resource usage', () => {
    it('counts only verified roots and their descendants', () => {
        const rows = parseUnixProcessTable(`
  10   1 S    8.0 100
  11  10 R   52.0 200
  12  11 D    4.0 300
  20   1 R   99.0 900
`)
        const managed = selectManagedProcessRows(rows, new Set([10]))

        expect(managed.map((row) => row.pid)).toEqual([10, 11, 12])
        expect(summarizeManagedProcessRows(managed, 4, 10 * 1024 * 1024)).toEqual({
            cpuPercent: 16,
            memoryBytes: 600 * 1024,
            memoryPercent: 5.9,
            processes: { total: 3, active: 1, sleeping: 2, other: 0 }
        })
    })

    it('excludes the temporary ps sampler process', () => {
        const rows = parseUnixProcessTable('30 10 R 100.0 10\n10 1 S 0.0 20', 30)
        expect(rows.map((row) => row.pid)).toEqual([10])
    })
})
