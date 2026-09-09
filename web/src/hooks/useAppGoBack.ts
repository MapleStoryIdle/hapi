import { useCallback } from 'react'
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router'

export function useAppGoBack(): () => void {
    const navigate = useNavigate()
    const router = useRouter()
    const pathname = useLocation({ select: (location) => location.pathname })
    const search = useLocation({ select: (location) => location.search })

    return useCallback(() => {
        // Use explicit path navigation for consistent behavior across all environments
        if (pathname === '/sessions/new') {
            navigate({ to: '/sessions' })
            return
        }

        // Settings page always goes back to sessions
        if (pathname === '/settings') {
            navigate({ to: '/sessions' })
            return
        }

        // Kanban list always returns to the session list instead of browser history.
        if (pathname === '/shares') {
            navigate({ to: '/sessions' })
            return
        }

        // Monitor list is a secondary top-level screen; a direct link should
        // still have a dependable way back to the session home.
        if (pathname === '/monitors') {
            navigate({ to: '/sessions' })
            return
        }

        if (pathname.startsWith('/monitors/')) {
            navigate({ to: '/monitors' })
            return
        }

        // For single file view, go back to the source surface when it is explicit.
        if (pathname.match(/^\/sessions\/[^/]+\/file$/)) {
            const from = (search && typeof search === 'object' && 'from' in search)
                ? (search as { from?: unknown }).from
                : undefined

            if (from === 'session') {
                navigate({ to: pathname.replace(/\/file$/, '') })
                return
            }

            const tab = (search && typeof search === 'object' && 'tab' in search)
                ? (search as { tab?: unknown }).tab
                : undefined
            const nextSearch = tab === 'directories' ? { tab: 'directories' as const } : {}

            const filesPath = pathname.replace(/\/file$/, '/files')
            navigate({ to: filesPath, search: nextSearch })
            return
        }

        // For session routes, navigate to parent path
        if (pathname.startsWith('/sessions/')) {
            const parentPath = pathname.replace(/\/[^/]+$/, '') || '/sessions'
            navigate({ to: parentPath })
            return
        }

        // Fallback to history.back() for other cases
        router.history.back()
    }, [navigate, pathname, router, search])
}
