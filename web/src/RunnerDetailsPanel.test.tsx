import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/types/api'

vi.mock('@/hooks/queries/useRunnerRelease', () => ({
    useRunnerRelease: () => ({ version: '1.0.4' })
}))

import { RunnerDetailsPanel } from './router'

const machine = {
    id: 'machine-technical-id',
    namespace: 'test',
    seq: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    active: true,
    activeAt: Date.now(),
    metadata: {
        host: 'Mac-mini.local',
        platform: 'darwin',
        happyCliVersion: '1.0.4',
        runnerVersion: '1.0.4'
    },
    metadataVersion: 1,
    runnerState: {
        status: 'running',
        pid: 41793,
        httpPort: 59364,
        startedAt: Date.now() - 60_000
    },
    runnerStateVersion: 1,
    health: {
        collectedAt: Date.now(),
        uptimeSeconds: 60,
        load1m: 1.7,
        cpuPercent: 9,
        memoryPercent: 93,
        disk: { usedPercent: 97, path: '/', totalBytes: 100, freeBytes: 3 },
        shapi: {
            cpuPercent: 12.4,
            memoryBytes: 680 * 1024 * 1024,
            memoryPercent: 2.1,
            diskBytes: 2.3 * 1024 * 1024 * 1024,
            diskPath: '/Users/dev/.hapi',
            processes: { total: 18, active: 3, sleeping: 14, other: 1 }
        },
        networkInterfaces: [{ name: 'en1', address: '192.168.2.38', family: 'IPv4' }],
        agentCli: [{ id: 'codex', label: 'Codex', command: 'codex', available: true }]
    }
} satisfies Machine

describe('RunnerDetailsPanel', () => {
    it('keeps operational details behind a separate tab', () => {
        render(<RunnerDetailsPanel machine={machine} />)

        expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getAllByText('CPU')).toHaveLength(2)
        expect(screen.getByText('Runner 占用')).toBeInTheDocument()
        expect(screen.getByText('680 MiB')).toBeInTheDocument()
        expect(screen.queryByText('整机归一化')).not.toBeInTheDocument()
        expect(screen.queryByText('2.1% 整机')).not.toBeInTheDocument()
        expect(screen.queryByText('/Users/dev/.hapi')).not.toBeInTheDocument()
        expect(screen.getByText('18')).toBeInTheDocument()
        expect(screen.getByText('活跃')).toBeInTheDocument()
        expect(screen.getByText('睡眠')).toBeInTheDocument()
        expect(screen.queryByText('machine-technical-id')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: '详情' }))

        expect(screen.getByText('machine-technical-id')).toBeInTheDocument()
        expect(screen.getByText('Codex · 可用')).toBeInTheDocument()
        expect(screen.queryByText('CPU')).not.toBeInTheDocument()
    })
})
