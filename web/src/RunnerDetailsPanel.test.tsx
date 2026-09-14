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
        networkInterfaces: [{ name: 'en1', address: '192.168.2.38', family: 'IPv4' }],
        agentCli: [{ id: 'codex', label: 'Codex', command: 'codex', available: true }]
    }
} satisfies Machine

describe('RunnerDetailsPanel', () => {
    it('keeps operational details behind a separate tab', () => {
        render(<RunnerDetailsPanel machine={machine} />)

        expect(screen.getByRole('tab', { name: '概览' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByText('CPU')).toBeInTheDocument()
        expect(screen.queryByText('machine-technical-id')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: '详情' }))

        expect(screen.getByText('machine-technical-id')).toBeInTheDocument()
        expect(screen.getByText('Codex · 可用')).toBeInTheDocument()
        expect(screen.queryByText('CPU')).not.toBeInTheDocument()
    })
})
