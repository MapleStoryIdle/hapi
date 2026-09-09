import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MonitorIncident } from '@hapi/protocol/monitoring'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { MonitorIncidentCard } from './MonitorIncidentCard'

vi.mock('@tanstack/react-router', () => ({
    Link: ({ children, to: _to, params: _params, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & {
        children: ReactNode
        to?: unknown
        params?: unknown
    }) => <a href="#" {...props}>{children}</a>
}))

afterEach(() => {
    cleanup()
})

function reviewIncident(): MonitorIncident {
    return {
        id: 'incident-1',
        monitorId: 'monitor-1',
        createdAt: 1,
        updatedAt: 2,
        state: 'review',
        summary: 'Investigate elevated errors',
        sessionId: null,
        repairSessionId: null,
        plan: '## Repair plan\n\nRestart only after this approval.',
        planHash: 'reviewed-plan-hash',
        error: null,
        approvalContext: {
            machineId: 'machine-original',
            directory: '/workspace/original-service',
            agent: 'codex',
            model: 'gpt-5.6',
            reasoningEffort: 'high',
            permissionMode: 'read-only'
        }
    }
}

describe('MonitorIncidentCard', () => {
    it('requires the second confirmation and sends the immutable reviewed plan hash', async () => {
        const approveMonitorIncident = vi.fn().mockResolvedValue({ accepted: true })
        const onChanged = vi.fn().mockResolvedValue(undefined)
        const api = { approveMonitorIncident, closeMonitorIncident: vi.fn() } as unknown as ApiClient

        render(
            <I18nProvider>
                <MonitorIncidentCard
                    api={api}
                    monitorId="monitor-1"
                    incident={reviewIncident()}
                    locale="en-US"
                    t={(key) => ({
                        'monitors.incident.confirmRepair': 'Confirm repair',
                        'monitors.incident.close': 'Close incident',
                        'monitors.incident.viewPlan': 'View plan',
                        'monitors.incident.hidePlan': 'Hide plan',
                        'monitors.incident.repairConfirm.title': 'Approve this repair?',
                        'monitors.incident.repairConfirm.description': 'Approve the exact plan.',
                        'monitors.incident.repairConfirm.confirm': 'Approve repair',
                        'monitors.incident.repairConfirm.confirming': 'Approving…',
                        'monitors.incident.closeConfirm.title': 'Close this incident?',
                        'monitors.incident.closeConfirm.description': 'Stop the incident.',
                        'monitors.incident.closeConfirm.confirm': 'Close incident',
                        'monitors.incident.closeConfirm.confirming': 'Closing…',
                        'monitors.incident.planChanged': 'Plan changed',
                        'monitors.incident.state.review': 'Needs review',
                        'monitors.incident.approvalTarget': 'Approved repair target',
                        'monitors.incident.approvalTargetHint': 'Original target',
                        'monitors.incident.approvalTargetDefault': 'Default',
                        'monitors.incident.targetMachine': 'Machine',
                        'monitors.incident.targetDirectory': 'Directory',
                        'monitors.incident.targetAgent': 'Agent',
                        'monitors.incident.targetModel': 'Model',
                        'monitors.incident.targetReasoning': 'Reasoning',
                        'monitors.incident.targetPermission': 'Permission after approval'
                    }[key] ?? key)}
                    onChanged={onChanged}
                />
            </I18nProvider>
        )

        expect(screen.queryByTestId('monitor-confirm-repair')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'View plan' }))
        expect(screen.getByTestId('monitor-approval-context')).toHaveTextContent('machine-original')
        expect(screen.getByTestId('monitor-approval-context')).toHaveTextContent('/workspace/original-service')
        fireEvent.click(screen.getByTestId('monitor-confirm-repair'))
        expect(screen.getByRole('dialog')).toHaveTextContent('Approve this repair?')
        expect(screen.getByRole('dialog')).toHaveTextContent('machine-original')
        expect(screen.getByRole('dialog')).toHaveTextContent('/workspace/original-service')
        expect(approveMonitorIncident).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Approve repair' }))

        await waitFor(() => expect(approveMonitorIncident).toHaveBeenCalledWith(
            'monitor-1',
            'incident-1',
            'reviewed-plan-hash'
        ))
        await waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    })

    it('does not offer an invalid close while an investigation is running and points to its session', () => {
        const running = {
            ...reviewIncident(),
            state: 'investigating' as const,
            plan: null,
            planHash: null,
            approvalContext: undefined,
            sessionId: 'session-running'
        }

        render(
            <I18nProvider>
                <MonitorIncidentCard
                    api={{ approveMonitorIncident: vi.fn(), closeMonitorIncident: vi.fn() } as unknown as ApiClient}
                    monitorId="monitor-1"
                    incident={running}
                    locale="en-US"
                    t={(key) => ({
                        'monitors.incident.state.investigating': 'Investigating',
                        'monitors.incident.investigationSession': 'Investigation session',
                        'monitors.incident.closeRunningHint': 'Open its session to stop it before closing this event.'
                    }[key] ?? key)}
                    onChanged={vi.fn().mockResolvedValue(undefined)}
                />
            </I18nProvider>
        )

        expect(screen.queryByRole('button', { name: 'monitors.incident.close' })).not.toBeInTheDocument()
        expect(screen.getByText('Open its session to stop it before closing this event.')).toBeInTheDocument()
        expect(screen.getByRole('link', { name: 'Investigation session' })).toBeInTheDocument()
    })
})
