import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import type { ShareDetails } from '@/types/api'
import KanbanTaskPage from './kanban-task'

const { mockApi, navigate } = vi.hoisted(() => ({
    mockApi: {
        getShare: vi.fn(),
        getShareContent: vi.fn(),
        revokeShare: vi.fn()
    },
    navigate: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ shareId: 'share-1' }),
    useNavigate: () => navigate
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: mockApi, baseUrl: 'http://hub.test', token: 'test-token' })
}))

vi.mock('@/lib/toast-context', () => ({
    useToast: () => ({ addToast: vi.fn() })
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: () => <div />
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: () => null
}))

const details: ShareDetails = {
    id: 'share-1',
    filename: 'note.md',
    size: 4,
    createdAt: 1,
    expiresAt: 2,
    source: null,
    sourceContext: {
        directoryName: 'full-directory-name-that-the-card-may-truncate',
        gitBranch: 'feature/kanban-timeline'
    },
    status: 'published',
    feedback: null,
    url: null
}

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <KanbanTaskPage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

afterEach(() => cleanup())

describe('KanbanTaskPage source context', () => {
    it('shows the full directory name and optional Git branch in the Info tab', async () => {
        mockApi.getShare.mockResolvedValue({ share: details })
        mockApi.getShareContent.mockResolvedValue({ content: '# note' })

        renderPage()

        fireEvent.click(await screen.findByRole('tab', { name: 'Info' }))
        expect(screen.getByText('Directory')).toBeInTheDocument()
        expect(screen.getByTestId('share-detail-directory')).toHaveTextContent('full-directory-name-that-the-card-may-truncate')
        expect(screen.getByText('Git branch')).toBeInTheDocument()
        expect(screen.getByTestId('share-detail-git-branch')).toHaveTextContent('feature/kanban-timeline')
    })
})
