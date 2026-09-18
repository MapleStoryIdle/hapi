export interface RunnerReleaseManifest {
    version: string
    publishedAt?: string
}

export type RunnerVersionStatus = 'outdated' | 'current' | 'ahead' | 'unknown'

function parseStableVersion(value: string | null | undefined): [number, number, number] | null {
    if (!value) return null
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
    if (!match) return null
    return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareRunnerVersion(
    currentVersion: string | null | undefined,
    latestVersion: string | null | undefined,
): RunnerVersionStatus {
    const current = parseStableVersion(currentVersion)
    const latest = parseStableVersion(latestVersion)
    if (!current || !latest) return 'unknown'
    for (let index = 0; index < current.length; index += 1) {
        if (current[index] < latest[index]) return 'outdated'
        if (current[index] > latest[index]) return 'ahead'
    }
    return 'current'
}

export function parseRunnerReleaseManifest(value: unknown): RunnerReleaseManifest | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.version !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(record.version)) return null
    if (record.publishedAt !== undefined && typeof record.publishedAt !== 'string') return null
    return {
        version: record.version.replace(/^v/, ''),
        publishedAt: record.publishedAt,
    }
}
