import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { ShareCard, ShareDetailsDialog, ShareFeedbackDialog } from './shares'

const share = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2,
    sourceSessionId: null,
    status: 'published' as const,
    feedback: null
}

const detailLabels = {
    title: 'Shared file details',
    loading: 'Loading details…',
    size: 'File size',
    createdAt: 'Created',
    expiresAt: 'Expires',
    link: 'Public link',
    unavailable: 'This is a legacy share. Its original link was not saved and cannot be copied.',
    copy: 'Copy link',
    copied: 'Copied',
    document: 'Shared document',
    documentLoading: 'Loading shared document…',
    documentUnavailable: 'Shared document cannot be viewed right now',
    markdown: 'Markdown',
    source: 'Source'
}

const feedbackLabels = {
    title: 'Agent feedback',
    loading: 'Loading feedback…',
    metadata: 'Agent-reported metadata',
    agent: 'Agent',
    model: 'Model',
    environment: 'Environment',
    content: 'Feedback body',
    markdown: 'Markdown',
    source: 'Source',
    sendToSession: 'Send to source session',
    sendingToSession: 'Sending…',
    reviewSent: 'Sent'
}

afterEach(() => cleanup())

beforeEach(() => {
    vi.clearAllMocks()
})

describe('ShareCard', () => {
    it('opens details when the file card is clicked', () => {
        const onDetails = vi.fn()
        render(
            <LazyMotion features={domAnimation} strict>
                <MotionConfig reducedMotion="user">
                    <ShareCard
                        share={share}
                        locale="en-US"
                        busy={false}
                        onDetails={onDetails}
                        onRevoke={vi.fn()}
                        labels={{
                            createdAt: 'Created',
                            expiresAt: 'Expires',
                            revoke: 'Revoke',
                            revokeLabel: 'Revoke',
                            detailsLabel: 'View details'
                        }}
                    />
                </MotionConfig>
            </LazyMotion>
        )

        fireEvent.click(screen.getByRole('button', { name: 'View details: note.md' }))
        expect(onDetails).toHaveBeenCalledWith(share)
    })

    it('opens the original session from the task session icon', () => {
        const onOpenSourceSession = vi.fn()
        render(
            <LazyMotion features={domAnimation} strict>
                <MotionConfig reducedMotion="user">
                    <ShareCard
                        share={{ ...share, sourceSessionId: 'source-session' }}
                        locale="en-US"
                        busy={false}
                        onDetails={vi.fn()}
                        onRevoke={vi.fn()}
                        onOpenSourceSession={onOpenSourceSession}
                        labels={{
                            createdAt: 'Created',
                            expiresAt: 'Expires',
                            revoke: 'Revoke',
                            revokeLabel: 'Revoke',
                            detailsLabel: 'View details',
                            sourceSessionLabel: 'Open source session'
                        }}
                    />
                </MotionConfig>
            </LazyMotion>
        )

        fireEvent.click(screen.getByRole('button', { name: 'Open source session: note.md' }))
        expect(onOpenSourceSession).toHaveBeenCalledWith('source-session')
    })
})

describe('ShareDetailsDialog', () => {
    it('shows and copies the stored original link', async () => {
        const url = 'https://example.test/s/token'
        const getShare = vi.fn().mockResolvedValue({ share: { ...share, url } })
        const getShareContent = vi.fn().mockResolvedValue({ content: '# README\n\n**Preview**' })
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

        render(
            <I18nProvider>
                <ShareDetailsDialog
                    api={{ getShare, getShareContent } as unknown as ApiClient}
                    share={share}
                    locale="en-US"
                    onClose={vi.fn()}
                    labels={detailLabels}
                />
            </I18nProvider>
        )

        await screen.findByText(url)
        expect(await screen.findByRole('heading', { name: 'README' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(url))
        expect(screen.getByText('Copied')).toBeInTheDocument()

        fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
        expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === '# README\n\n**Preview**')).toBeInTheDocument()
    })

    it('explains why a legacy share has no copy button', async () => {
        const getShare = vi.fn().mockResolvedValue({ share: { ...share, url: null } })
        const getShareContent = vi.fn().mockResolvedValue({ content: 'legacy text' })

        render(
            <I18nProvider>
                <ShareDetailsDialog
                    api={{ getShare, getShareContent } as unknown as ApiClient}
                    share={share}
                    locale="en-US"
                    onClose={vi.fn()}
                    labels={detailLabels}
                />
            </I18nProvider>
        )

        expect(await screen.findByText(detailLabels.unavailable)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
    })

    it('closes when Escape is pressed', async () => {
        const onClose = vi.fn()
        const getShare = vi.fn().mockResolvedValue({ share: { ...share, url: null } })
        const getShareContent = vi.fn().mockResolvedValue({ content: 'legacy text' })

        render(
            <I18nProvider>
                <ShareDetailsDialog
                    api={{ getShare, getShareContent } as unknown as ApiClient}
                    share={share}
                    locale="en-US"
                    onClose={onClose}
                    labels={detailLabels}
                />
            </I18nProvider>
        )

        await screen.findByRole('dialog')
        fireEvent.keyDown(document, { key: 'Escape' })

        expect(onClose).toHaveBeenCalledTimes(1)
    })
})

describe('ShareFeedbackDialog', () => {
    it('defaults a received Markdown document to preview and can switch to source', async () => {
        const getShareFeedback = vi.fn().mockResolvedValue({
            feedback: {
                filename: 'review.md',
                size: 20,
                receivedAt: 1,
                reviewDeliveredAt: null,
                metadata: {
                    agent: { name: 'reviewer', version: '1' },
                    model: { provider: 'openai', id: 'gpt-5', reasoningEffort: null },
                    environment: { os: 'macOS', arch: 'arm64', runtime: 'codex' }
                },
                content: '# Review\n\n**Safe**'
            }
        })

        render(
            <I18nProvider>
                <ShareFeedbackDialog
                    api={{ getShareFeedback } as unknown as ApiClient}
                    share={{
                        ...share,
                        sourceSessionId: 'source-session',
                        status: 'feedback_received',
                        feedback: {
                            filename: 'review.md',
                            size: 20,
                            receivedAt: 1,
                            reviewDeliveredAt: null,
                            metadata: {
                                agent: { name: 'reviewer', version: '1' },
                                model: { provider: 'openai', id: 'gpt-5', reasoningEffort: null },
                                environment: { os: 'macOS', arch: 'arm64', runtime: 'codex' }
                            }
                        }
                    }}
                    onClose={vi.fn()}
                    onDelivered={vi.fn().mockResolvedValue(undefined)}
                    labels={feedbackLabels}
                />
            </I18nProvider>
        )

        expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('tab', { name: 'Source' }))
        expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === '# Review\n\n**Safe**')).toBeInTheDocument()
    })
})
