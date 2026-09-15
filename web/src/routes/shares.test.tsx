import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import type { ShareSummary } from '@/types/api'

const testRuntime = vi.hoisted(() => ({
    mockApi: {
        getShare: vi.fn(),
        deliverShareFeedback: vi.fn(),
        revokeShare: vi.fn()
    },
    navigate: vi.fn(),
    goBack: vi.fn(),
    addToast: vi.fn(),
    copy: vi.fn(),
    sharesState: {
        shares: [] as ShareSummary[],
        isLoading: false,
        error: null as Error | null,
        refetch: vi.fn()
    }
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => testRuntime.navigate
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: testRuntime.mockApi,
        baseUrl: 'http://hub.test',
        token: 'test-token'
    })
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: testRuntime.addToast })
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => testRuntime.goBack
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({ copied: false, copy: testRuntime.copy })
}))

vi.mock('@/hooks/useLocalDayKey', () => ({
    useLocalDayKey: () => '2026-09-02'
}))

vi.mock('@/hooks/queries/useShares', () => ({
    useShares: () => testRuntime.sharesState
}))

import SharesPage, {
    feedbackDeliveryFailureToast,
    getShareFilterBucket,
    matchesShareFilter,
    matchesShareSearch,
    ShareCard
} from './shares'

const share: ShareSummary = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2,
    source: { type: 'hapi', sessionId: 'source-session' },
    sourceContext: {
        directoryName: 'hapi',
        gitBranch: 'feature/kanban-timeline'
    },
    status: 'feedback_received',
    feedback: {
        filename: 'feedback.md',
        size: 6,
        receivedAt: 3,
        metadata: {
            agent: { name: 'reviewer', version: '1' },
            model: { provider: 'openai', id: 'gpt-5', reasoningEffort: null },
            environment: { os: 'macOS', arch: 'arm64', runtime: 'codex' }
        },
        reviewDeliveredAt: null
    }
}

const labels = {
    expiresAt: 'Expires',
    copy: 'Copy',
    copyLink: 'Copy public link',
    source: 'Source',
    sourceSession: 'Open source session',
    deliver: 'Deliver',
    deliverToSource: 'Deliver to source session',
    more: 'More',
    details: 'View details',
    revoke: 'Revoke'
}

function renderShareCard(
    overrides: Partial<Parameters<typeof ShareCard>[0]> = {}
) {
    const handlers = {
        onCopyLink: vi.fn(),
        onOpenSourceSession: vi.fn(),
        onDeliverToSourceSession: vi.fn(),
        onOpenDetails: vi.fn(),
        onRevoke: vi.fn()
    }

    render(
        <LazyMotion features={domAnimation} strict>
            <MotionConfig reducedMotion="user">
                <ShareCard
                    share={share}
                    locale="en-US"
                    now={0}
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

function makePageShare(
    id: string,
    status: ShareSummary['status'],
    overrides: Partial<ShareSummary> = {}
): ShareSummary {
    const now = Date.now()
    const hasFeedback =
        status === 'feedback_received' ||
        status === 'review_sending' ||
        status === 'review_sent'
    return {
        ...share,
        id,
        filename: `${id}.md`,
        createdAt: now - 5 * 60 * 1000,
        expiresAt: now + 2 * 24 * 60 * 60 * 1000,
        status,
        feedback: hasFeedback ? share.feedback : null,
        ...overrides
    }
}

function renderSharesPage() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } }
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SharesPage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

beforeEach(() => {
    localStorage.removeItem('hapi-lang')
    testRuntime.mockApi.getShare.mockReset()
    testRuntime.mockApi.deliverShareFeedback.mockReset()
    testRuntime.mockApi.revokeShare.mockReset()
    testRuntime.navigate.mockReset()
    testRuntime.goBack.mockReset()
    testRuntime.addToast.mockReset()
    testRuntime.copy.mockReset()
    testRuntime.copy.mockResolvedValue(true)
    testRuntime.sharesState.shares = []
    testRuntime.sharesState.isLoading = false
    testRuntime.sharesState.error = null
    testRuntime.sharesState.refetch.mockReset()
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe('ShareCard', () => {
    it('opens details from the compact card and keeps only actionable toolbar actions', () => {
        const handlers = renderShareCard()

        const detailsButton = screen.getByRole('button', {
            name: 'View details: note.md'
        })
        const moreButton = screen.getByRole('button', { name: 'More' })
        expect(detailsButton.parentElement).not.toHaveClass(
            'border-l-emerald-500'
        )
        expect(screen.queryByText('Feedback received')).toBeNull()
        expect(screen.queryByText('Created')).toBeNull()
        expect(screen.getByTestId('share-size')).toHaveTextContent('4 B')
        expect(screen.getByTestId('share-source-context')).toHaveTextContent(
            'hapi'
        )
        expect(screen.getByTestId('share-source-context')).toHaveTextContent(
            'feature/kanban-timeline'
        )
        expect(
            screen.getByRole('button', { name: 'Copy public link' })
        ).toHaveClass('h-11')
        expect(
            screen.getByRole('button', { name: 'Open source session' })
        ).toHaveClass('h-11')
        expect(
            screen.getByRole('button', { name: 'Deliver to source session' })
        ).toHaveClass('h-11')
        expect(moreButton).toHaveAttribute('aria-expanded', 'false')

        fireEvent.click(detailsButton)
        fireEvent.click(
            screen.getByRole('button', { name: 'Copy public link' })
        )
        fireEvent.click(
            screen.getByRole('button', { name: 'Open source session' })
        )
        fireEvent.click(
            screen.getByRole('button', { name: 'Deliver to source session' })
        )
        fireEvent.click(moreButton)
        fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

        expect(handlers.onOpenDetails).toHaveBeenCalledWith(share)
        expect(handlers.onCopyLink).toHaveBeenCalledWith(share)
        expect(handlers.onOpenSourceSession).toHaveBeenCalledWith({
            type: 'hapi',
            sessionId: 'source-session'
        })
        expect(handlers.onDeliverToSourceSession).toHaveBeenCalledWith(share)
        expect(handlers.onRevoke).toHaveBeenCalledWith(share)
        expect(
            screen.queryByRole('button', { name: /^View details$/ })
        ).toBeNull()
        expect(
            screen
                .getByRole('button', { name: 'Open source session' })
                .querySelector('path[d^="M20.25 12"]')
        ).not.toBeNull()
    })

    it('keeps revoke inside a keyboard-dismissible More disclosure', () => {
        renderShareCard()

        const moreButton = screen.getByRole('button', { name: 'More' })
        fireEvent.click(moreButton)
        expect(moreButton).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument()

        fireEvent.keyDown(document, { key: 'Escape' })
        expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
        expect(moreButton).toHaveFocus()

        fireEvent.click(moreButton)
        fireEvent.pointerDown(document.body)
        expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull()
    })

    it('omits unavailable source and delivery actions instead of showing disabled actions', () => {
        renderShareCard({
            share: {
                ...share,
                source: null,
                sourceContext: null,
                status: 'awaiting_feedback',
                feedback: null
            }
        })

        expect(
            screen.queryByRole('button', { name: 'Open source session' })
        ).toBeNull()
        expect(
            screen.queryByRole('button', { name: 'Deliver to source session' })
        ).toBeNull()
        expect(screen.getByRole('button', { name: 'More' })).toBeEnabled()
        expect(screen.queryByTestId('share-source-context')).toBeNull()
    })

    it('omits Deliver while a received review is already being sent', () => {
        renderShareCard({
            share: {
                ...share,
                status: 'review_sending'
            }
        })

        expect(
            screen.getByRole('button', { name: 'Open source session' })
        ).toBeEnabled()
        expect(
            screen.queryByRole('button', { name: 'Deliver to source session' })
        ).toBeNull()
    })

    it('shows only the directory name when Git is unavailable', () => {
        renderShareCard({
            share: {
                ...share,
                sourceContext: { directoryName: 'hapi', gitBranch: null }
            }
        })

        expect(screen.getByTestId('share-source-context')).toHaveTextContent(
            'hapi'
        )
        expect(screen.getByTestId('share-source-context')).toHaveTextContent(
            /^hapi$/
        )
    })
})

describe('share list filters', () => {
    it('maps every backend status to the approved compact filter bucket', () => {
        expect(getShareFilterBucket('published')).toBe('waiting')
        expect(getShareFilterBucket('awaiting_feedback')).toBe('waiting')
        expect(getShareFilterBucket('feedback_received')).toBe('feedback')
        expect(getShareFilterBucket('review_sending')).toBe('feedback')
        expect(getShareFilterBucket('review_sent')).toBe('delivered')
        expect(
            matchesShareFilter(
                { ...share, status: 'review_sending' },
                'feedback'
            )
        ).toBe(true)
        expect(
            matchesShareFilter(
                { ...share, status: 'review_sending' },
                'waiting'
            )
        ).toBe(false)
    })

    it('searches filename, source directory, and Git branch', () => {
        expect(matchesShareSearch(share, 'note')).toBe(true)
        expect(matchesShareSearch(share, 'hapi')).toBe(true)
        expect(matchesShareSearch(share, 'kanban-timeline')).toBe(true)
        expect(matchesShareSearch(share, 'unrelated')).toBe(false)
    })
})

describe('SharesPage', () => {
    it('connects counted filters, search, timeline status, and empty results', () => {
        testRuntime.sharesState.shares = [
            makePageShare('published', 'published'),
            makePageShare('waiting', 'awaiting_feedback'),
            makePageShare('received', 'feedback_received'),
            makePageShare('sending', 'review_sending', {
                sourceContext: {
                    directoryName: 'hapi-web',
                    gitBranch: 'feature/sending-review'
                }
            }),
            makePageShare('delivered', 'review_sent')
        ]

        renderSharesPage()

        expect(
            screen.getByText('5 tasks · 1 new feedback item')
        ).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: /^New feedback 2 shares$/ })
        ).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Refresh shares' }))
        expect(testRuntime.sharesState.refetch).toHaveBeenCalledTimes(1)

        const receivedStatus = screen.getByText('Feedback received')
        const eventRow = receivedStatus.closest('div')
        expect(eventRow?.firstElementChild?.tagName).toBe('TIME')
        expect(eventRow?.lastElementChild).toContainElement(receivedStatus)
        expect(
            screen.getByRole('button', {
                name: 'View details: received.md'
            })
        ).not.toHaveTextContent('Feedback received')

        fireEvent.click(
            screen.getByRole('button', { name: /^New feedback 2 shares$/ })
        )
        expect(screen.getByText('received.md')).toBeInTheDocument()
        expect(screen.getByText('sending.md')).toBeInTheDocument()
        expect(screen.queryByText('waiting.md')).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: /^All 5 shares$/ }))
        fireEvent.change(screen.getByLabelText('Search shares'), {
            target: { value: 'sending-review' }
        })
        expect(screen.getByText('sending.md')).toBeInTheDocument()
        expect(screen.queryByText('received.md')).toBeNull()

        fireEvent.change(screen.getByLabelText('Search shares'), {
            target: { value: 'not-present' }
        })
        expect(
            screen.getByText('No shares match this search or filter.')
        ).toBeInTheDocument()
    })

    it('preserves copy, source, deliver, and confirmed revoke flows', async () => {
        const feedbackShare = makePageShare('review', 'feedback_received')
        testRuntime.sharesState.shares = [feedbackShare]
        testRuntime.mockApi.getShare.mockResolvedValue({
            share: { ...feedbackShare, url: 'https://hapi.test/share/review' }
        })
        testRuntime.mockApi.deliverShareFeedback.mockResolvedValue({
            ok: true,
            status: 'review_sent'
        })
        testRuntime.mockApi.revokeShare.mockResolvedValue({ ok: true })

        renderSharesPage()

        expect(
            screen.getByText('1 task · 1 new feedback item')
        ).toBeInTheDocument()
        expect(
            screen.getByRole('button', { name: /^All 1 share$/ })
        ).toBeInTheDocument()

        fireEvent.click(
            screen.getByRole('button', { name: 'Copy public link' })
        )
        await waitFor(() => {
            expect(testRuntime.mockApi.getShare).toHaveBeenCalledWith('review')
            expect(testRuntime.copy).toHaveBeenCalledWith(
                'https://hapi.test/share/review'
            )
        })

        fireEvent.click(
            screen.getByRole('button', { name: 'Open source session' })
        )
        expect(testRuntime.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'source-session' }
        })

        fireEvent.click(
            screen.getByRole('button', { name: 'Deliver to source session' })
        )
        await waitFor(() => {
            expect(
                testRuntime.mockApi.deliverShareFeedback
            ).toHaveBeenCalledWith('review')
        })

        fireEvent.click(screen.getByRole('button', { name: 'More' }))
        fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
        expect(screen.getByText('Revoke public access?')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Revoke link' }))
        await waitFor(() => {
            expect(testRuntime.mockApi.revokeShare).toHaveBeenCalledWith(
                'review'
            )
        })
    })

    it('keeps the copy failure recovery toast wired at page level', async () => {
        testRuntime.sharesState.shares = [
            makePageShare('copy-failure', 'awaiting_feedback')
        ]
        testRuntime.mockApi.getShare.mockRejectedValue(
            new Error('clipboard source unavailable')
        )

        renderSharesPage()
        fireEvent.click(
            screen.getByRole('button', { name: 'Copy public link' })
        )

        await waitFor(() => {
            expect(testRuntime.addToast).toHaveBeenCalledWith(
                expect.objectContaining({
                    title: 'Could not copy link',
                    kind: 'error'
                })
            )
        })
    })

    it('refreshes relative expiry while the page remains open', () => {
        vi.useFakeTimers()
        const start = new Date('2026-09-02T08:00:00Z').getTime()
        vi.setSystemTime(start)
        testRuntime.sharesState.shares = [
            makePageShare('timer', 'awaiting_feedback', {
                createdAt: start - 5 * 60 * 1000,
                expiresAt: start + 61 * 60 * 1000
            })
        ]

        renderSharesPage()
        expect(screen.getByText('in 2 hours')).toBeInTheDocument()

        act(() => vi.advanceTimersByTime(2 * 60 * 1000))
        expect(screen.getByText('in 59 minutes')).toBeInTheDocument()
    })
})

describe('feedback delivery failure toast', () => {
    it('maps an unsafe source permission error to a source-session toast', () => {
        const toast = feedbackDeliveryFailureToast(
            share,
            new ApiError(
                'unsafe mode',
                409,
                'source_session_permission_unsafe'
            ),
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
                source: {
                    type: 'native-codex',
                    machineId: 'machine-1',
                    codexSessionId: 'native-session'
                }
            },
            new ApiError(
                'runner offline',
                409,
                'native_source_machine_offline'
            ),
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
