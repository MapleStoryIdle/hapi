import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import type { ShareSummary } from '@/types/api'
import { ShareCard } from './shares'

const share: ShareSummary = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2,
    sourceSessionId: 'source-session',
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
                    statusLabel="Feedback received"
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

        fireEvent.click(screen.getByRole('button', { name: 'View details: note.md' }))
        fireEvent.click(screen.getByRole('button', { name: 'Copy public link' }))
        fireEvent.click(screen.getByRole('button', { name: 'Open source session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Deliver to source session' }))
        fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

        expect(handlers.onOpenDetails).toHaveBeenCalledWith(share)
        expect(handlers.onCopyLink).toHaveBeenCalledWith(share)
        expect(handlers.onOpenSourceSession).toHaveBeenCalledWith('source-session')
        expect(handlers.onDeliverToSourceSession).toHaveBeenCalledWith(share)
        expect(handlers.onRevoke).toHaveBeenCalledWith(share)
        expect(screen.queryByRole('button', { name: /^View details$/ })).toBeNull()
    })

    it('clearly disables source-dependent actions when the task cannot use them', () => {
        renderShareCard({
            share: {
                ...share,
                sourceSessionId: null,
                status: 'awaiting_feedback',
                feedback: null,
            },
        })

        expect(screen.getByRole('button', { name: 'No source session' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Delivery unavailable' })).toBeDisabled()
    })
})
