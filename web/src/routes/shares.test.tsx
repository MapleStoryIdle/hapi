import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { ApiError } from '@/api/client'
import type { ShareSummary } from '@/types/api'
import { feedbackDeliveryFailureToast, ShareCard } from './shares'

const share: ShareSummary = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2,
    source: { type: 'hapi', sessionId: 'source-session' },
    status: 'feedback_received',
    feedback: {
        filename: 'feedback.md',
        size: 6,
        receivedAt: 3,
        metadata: {
            agent: { name: 'reviewer', version: '1' },
            model: { provider: 'openai', id: 'gpt-5', reasoningEffort: null },
            environment: { os: 'macOS', arch: 'arm64', runtime: 'codex' },
        },
        reviewDeliveredAt: null,
    },
}

const labels = {
    createdAt: 'Created',
    expiresAt: 'Expires',
    copyLink: 'Copy public link',
    sourceSession: 'Open source session',
    sourceSessionUnavailable: 'No source session',
    deliverToSource: 'Deliver to source session',
    deliverUnavailable: 'Delivery unavailable',
    delivered: 'Delivered to source session',
    details: 'View details',
    revoke: 'Revoke',
}

function renderShareCard(overrides: Partial<Parameters<typeof ShareCard>[0]> = {}) {
    const handlers = {
        onCopyLink: vi.fn(),
        onOpenSourceSession: vi.fn(),
        onDeliverToSourceSession: vi.fn(),
        onOpenDetails: vi.fn(),
        onRevoke: vi.fn(),
    }

    render(
        <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
                <ShareCard
                    share={share}
                    locale="en-US"
                    pending={false}
                    labels={labels}
                    {...handlers}
                    {...overrides}
                />
            </MotionConfig>
        </LazyMotion>
    )

    return handlers
}

afterEach(() => cleanup())

describe('ShareCard', () => {
    it('opens details from the card body and keeps compact action icons separate', () => {
        const handlers = renderShareCard()

        const detailsButton = screen.getByRole('button', { name: 'View details: note.md' })
        expect(detailsButton.parentElement).toHaveClass('border-l-emerald-500')
        expect(screen.queryByText('Feedback received')).toBeNull()
        fireEvent.click(detailsButton)
        fireEvent.click(screen.getByRole('button', { name: 'Copy public link' }))
        fireEvent.click(screen.getByRole('button', { name: 'Open source session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Deliver to source session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

        expect(handlers.onOpenDetails).toHaveBeenCalledWith(share)
        expect(handlers.onCopyLink).toHaveBeenCalledWith(share)
        expect(handlers.onOpenSourceSession).toHaveBeenCalledWith({ type: 'hapi', sessionId: 'source-session' })
        expect(handlers.onDeliverToSourceSession).toHaveBeenCalledWith(share)
        expect(handlers.onRevoke).toHaveBeenCalledWith(share)
        expect(screen.queryByRole('button', { name: /^View details$/ })).toBeNull()
    })

    it('clearly disables source-dependent actions when the task cannot use them', () => {
        renderShareCard({
            share: {
                ...share,
                source: null,
                status: 'awaiting_feedback',
                feedback: null,
            },
        })

        expect(screen.getByRole('button', { name: 'No source session' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Delivery unavailable' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'View details: note.md' }).parentElement).not.toHaveClass('border-l-emerald-500')
    })

    it('maps an unsafe source permission error to a source-session toast', () => {
        const toast = feedbackDeliveryFailureToast(
            share,
            new ApiError('unsafe mode', 409, 'source_session_permission_unsafe'),
            (key) => key
        )

        expect(toast).toMatchObject({
            title: 'shares.toast.permissionUnsafe.title',
            body: 'shares.toast.permissionUnsafe.body',
            kind: 'error',
            sessionId: 'source-session',
            url: ''
        })
    })

    it('links a native source delivery error back to the exact native session', () => {
        const toast = feedbackDeliveryFailureToast(
            {
                ...share,
                source: { type: 'native-codex', machineId: 'machine-1', codexSessionId: 'native-session' },
            },
            new ApiError('runner offline', 409, 'native_source_machine_offline'),
            (key) => key
        )

        expect(toast).toMatchObject({
            title: 'shares.toast.sourceUnavailable.title',
            kind: 'error',
            sessionId: '',
            url: '/sessions/codex/native-session?machineId=machine-1'
        })
    })
})
