import { useQuery } from '@tanstack/react-query'
import { parseRunnerReleaseManifest, type RunnerReleaseManifest } from '@/lib/runnerRelease'

export function useRunnerRelease(): RunnerReleaseManifest | null {
    const query = useQuery({
        queryKey: ['runner-release', 'latest'],
        queryFn: async () => {
            const response = await fetch('/downloads/runner/latest.json', {
                cache: 'no-cache',
                credentials: 'omit',
            })
            if (!response.ok) throw new Error(`Unable to load Runner release (${response.status})`)
            const manifest = parseRunnerReleaseManifest(await response.json())
            if (!manifest) throw new Error('Invalid Runner release manifest')
            return manifest
        },
        staleTime: 5 * 60 * 1000,
        retry: false,
    })
    return query.data ?? null
}
