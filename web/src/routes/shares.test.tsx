import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import { ShareCard, ShareDetailsDialog } from './shares'

const share = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2
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
    copied: 'Copied'
}

afterEach(() => cleanup())

beforeEach(() => {
    vi.clearAllMocks()
})

describe('ShareCard', () => {
    it('opens details when the file card is clicked', () => {
        const onDetails = vi.fn()
        render(
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
        )

        fireEvent.click(screen.getByRole('button', { name: 'View details: note.md' }))
        expect(onDetails).toHaveBeenCalledWith(share)
    })
})

describe('ShareDetailsDialog', () => {
    it('shows and copies the stored original link', async () => {
        const url = 'https://example.test/s/token'
        const getShare = vi.fn().mockResolvedValue({ share: { ...share, url } })
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

        render(
            <I18nProvider>
                <ShareDetailsDialog
                    api={{ getShare } as unknown as ApiClient}
                    share={share}
                    locale="en-US"
                    onClose={vi.fn()}
                    labels={detailLabels}
                />
            </I18nProvider>
        )

        await screen.findByText(url)
        fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

        await waitFor(() => expect(writeText).toHaveBeenCalledWith(url))
        expect(screen.getByText('Copied')).toBeInTheDocument()
    })

    it('explains why a legacy share has no copy button', async () => {
        const getShare = vi.fn().mockResolvedValue({ share: { ...share, url: null } })

        render(
            <I18nProvider>
                <ShareDetailsDialog
                    api={{ getShare } as unknown as ApiClient}
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
})
