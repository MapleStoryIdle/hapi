import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import type { ApiClient } from '@/api/client'
import type { SkillSummary, SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { queryKeys } from '@/lib/query-keys'
import { getRecentSkills } from '@/lib/recent-skills'

function levenshteinDistance(left: string, right: string): number {
    if (left.length === 0) return right.length
    if (right.length === 0) return left.length

    const matrix: number[][] = []
    for (let row = 0; row <= right.length; row += 1) matrix[row] = [row]
    for (let column = 0; column <= left.length; column += 1) matrix[0][column] = column
    for (let row = 1; row <= right.length; row += 1) {
        for (let column = 1; column <= left.length; column += 1) {
            matrix[row][column] = left[column - 1] === right[row - 1]
                ? matrix[row - 1][column - 1]
                : Math.min(
                    matrix[row - 1][column - 1] + 1,
                    matrix[row - 1][column] + 1,
                    matrix[row][column - 1] + 1
                )
        }
    }
    return matrix[right.length][left.length]
}

function getMatchScore(searchTerm: string, candidate: string): number {
    if (candidate === searchTerm) return 0
    if (candidate.startsWith(searchTerm)) return 1
    if (candidate.includes(searchTerm)) return 2
    const distance = levenshteinDistance(searchTerm, candidate)
    return distance <= Math.max(2, Math.floor(searchTerm.length / 2)) ? 3 + distance : Infinity
}

function skillSuggestion(skill: SkillSummary): Suggestion {
    return {
        key: `$${skill.name}`,
        text: `$${skill.name}`,
        label: skill.name,
        description: skill.description,
        source: skill.scope === 'project' || skill.scope === 'user' || skill.scope === 'plugin'
            ? skill.scope
            : 'builtin'
    }
}

function commandSuggestion(command: SlashCommand): Suggestion {
    return {
        key: `/${command.name}`,
        text: `/${command.name}`,
        label: `/${command.name}`,
        description: command.description ?? 'Custom command',
        content: command.content,
        source: command.source
    }
}

/**
 * Native threads are controlled with plain `codex exec resume` prompts. The
 * runner resolves their workspace so discovery sees the same project prompts
 * and Skills as the original terminal session.
 */
export function useNativeCodexSessionComposerCapabilities(
    api: ApiClient | null,
    machineId: string | null | undefined,
    sessionId: string | null
): {
    commands: SlashCommand[]
    skills: SkillSummary[]
    isLoading: boolean
    error: string | null
    getSuggestions: (query: string) => Promise<Suggestion[]>
} {
    const resolvedMachineId = machineId ?? 'unknown'
    const resolvedSessionId = sessionId ?? 'unknown'
    const query = useQuery({
        queryKey: queryKeys.codexSessionComposerCapabilities(resolvedMachineId, resolvedSessionId),
        queryFn: async () => {
            if (!api || !machineId || !sessionId) {
                throw new Error('Native Codex session is unavailable')
            }
            return await api.getCodexSessionComposerCapabilities(sessionId, machineId)
        },
        enabled: Boolean(api && machineId && sessionId),
        staleTime: 60_000,
        gcTime: 30 * 60 * 1000,
        retry: false
    })

    const commands = useMemo(() => {
        if (query.data?.success !== true) return []
        // Defense in depth: never offer commands that look actionable but
        // only make sense in a SHAPI-owned Codex process.
        return query.data.commands.filter((command) => command.source !== 'builtin')
    }, [query.data])
    const skills = useMemo(() => query.data?.success === true ? query.data.skills : [], [query.data])

    const getSuggestions = useCallback(async (queryText: string): Promise<Suggestion[]> => {
        if (queryText.startsWith('$')) {
            const searchTerm = queryText.slice(1).toLowerCase()
            const recent = getRecentSkills()
            const getRecency = (name: string) => recent[name] ?? 0
            return skills
                .map((skill) => ({
                    skill,
                    score: searchTerm ? getMatchScore(searchTerm, skill.name.toLowerCase()) : 0,
                    recency: getRecency(skill.name)
                }))
                .filter((item) => item.score < Infinity)
                .sort((left, right) => (
                    left.score - right.score
                    || right.recency - left.recency
                    || left.skill.name.localeCompare(right.skill.name)
                ))
                .map(({ skill }) => skillSuggestion(skill))
        }

        if (queryText.startsWith('/')) {
            const searchTerm = queryText.slice(1).toLowerCase()
            return commands
                .map((command) => ({
                    command,
                    score: searchTerm ? getMatchScore(searchTerm, command.name.toLowerCase()) : 0
                }))
                .filter((item) => item.score < Infinity)
                .sort((left, right) => left.score - right.score || left.command.name.localeCompare(right.command.name))
                .map(({ command }) => commandSuggestion(command))
        }

        return []
    }, [commands, skills])

    return {
        commands,
        skills,
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load native composer capabilities' : null,
        getSuggestions
    }
}
