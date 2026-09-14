import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { OpenVikingPluginDashboard } from './OpenVikingPluginDashboard'

afterEach(() => {
    cleanup()
    localStorage.clear()
})

function renderDashboard(api: ApiClient) {
    return render(
        <I18nProvider>
            <OpenVikingPluginDashboard api={api} machineId="machine-1" files={<div>Memory files</div>} />
        </I18nProvider>
    )
}

describe('OpenVikingPluginDashboard', () => {
    it('loads operational metrics without starting the expensive quality scan', async () => {
        const api = {
            getOpenVikingMetrics: vi.fn(async () => ({
                ok: true,
                retrievalRequests: 12,
                zeroResultRate: 0.25,
                averageLatencyMs: 80,
                p95LatencyMs: 250,
                rerankFallbacks: 1,
                queuePending: 2,
                queueInProgress: 1
            })),
            getOpenVikingQuality: vi.fn()
        } as unknown as ApiClient

        renderDashboard(api)

        expect(await screen.findByText('12')).toBeInTheDocument()
        expect(screen.getByText('25.0%')).toBeInTheDocument()
        expect(screen.getByText('250 ms')).toBeInTheDocument()
        expect(api.getOpenVikingQuality).not.toHaveBeenCalled()
    })

    it('runs a retrieval test and renders ranked results', async () => {
        const api = {
            getOpenVikingMetrics: vi.fn(async () => ({ ok: true })),
            searchOpenViking: vi.fn(async () => ({
                ok: true,
                total: 1,
                durationMs: 9,
                hits: [{ uri: 'viking://~/memories/preference.md', contextType: 'memory', score: 0.92, abstract: 'Use compact cards' }]
            }))
        } as unknown as ApiClient

        renderDashboard(api)
        fireEvent.click(screen.getByRole('tab', { name: 'Search' }))
        fireEvent.change(screen.getByLabelText('Retrieval test query'), { target: { value: 'my UI preference' } })
        fireEvent.click(screen.getByRole('button', { name: 'Test' }))

        expect(await screen.findByText('viking://~/memories/preference.md')).toBeInTheDocument()
        expect(screen.getByText('Use compact cards')).toBeInTheDocument()
        expect(api.searchOpenViking).toHaveBeenCalledWith('machine-1', 'my UI preference')
    })

    it('starts the memory quality check only after an explicit tap', async () => {
        const api = {
            getOpenVikingMetrics: vi.fn(async () => ({ ok: true })),
            getOpenVikingQuality: vi.fn(async () => ({
                ok: true,
                scannedMemories: 7,
                duplicateGroups: 1,
                conflictGroups: 0,
                stale7d: 2,
                stale30d: 1,
                issues: []
            }))
        } as unknown as ApiClient

        renderDashboard(api)
        fireEvent.click(screen.getByRole('tab', { name: 'Quality' }))
        expect(api.getOpenVikingQuality).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Check now' }))

        await waitFor(() => expect(api.getOpenVikingQuality).toHaveBeenCalledWith('machine-1'))
        expect(screen.getByText('7')).toBeInTheDocument()
    })
})
