import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { parseStatusSummaryV2 } from '@/lib/gitParsers'
import { queryKeys } from '@/lib/query-keys'

const GIT_BRANCH_STALE_TIME_MS = 60_000

/**
 * Read only the branch line from `git status`. The session-list project header
 * deliberately avoids the file-diff requests used by the Files view.
 */
export function getGitBranchFromStatusOutput(statusOutput: string): string | null {
    const head = parseStatusSummaryV2(statusOutput).branch.head
    if (!head || head === '(initial)') {
        return null
    }
    return head === '(detached)' ? 'detached' : head
}

export function useGitBranch(
    api: ApiClient | null,
    sessionId: string | null,
    enabled = true
): {
    branch: string | null
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.gitBranch(resolvedSessionId),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }

            const result = await api.getGitStatus(sessionId)
            if (!result.success) {
                return null
            }
            return getGitBranchFromStatusOutput(result.stdout ?? '')
        },
        enabled: Boolean(enabled && api && sessionId),
        staleTime: GIT_BRANCH_STALE_TIME_MS,
        refetchOnWindowFocus: true,
        retry: false
    })

    return {
        branch: query.data ?? null
    }
}
