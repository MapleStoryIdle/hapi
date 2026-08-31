import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAppGoBack } from './useAppGoBack'

const { historyBack, navigate, state } = vi.hoisted(() => ({
    historyBack: vi.fn(),
    navigate: vi.fn(),
    state: {
        pathname: '/shares',
        search: {},
    },
}))

vi.mock('@tanstack/react-router', () => ({
    useLocation: ({ select }: { select: (location: typeof state) => unknown }) => select(state),
    useNavigate: () => navigate,
    useRouter: () => ({ history: { back: historyBack } }),
}))

describe('useAppGoBack', () => {
    it('always returns from the kanban list to the session list', () => {
        const { result } = renderHook(() => useAppGoBack())

        act(() => result.current())

        expect(navigate).toHaveBeenCalledWith({ to: '/sessions' })
        expect(historyBack).not.toHaveBeenCalled()
    })
})
