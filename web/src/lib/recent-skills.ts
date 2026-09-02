const RECENT_SKILLS_KEY = 'hapi-recent-skills'
const MAX_RECENT_SKILLS = 200
const PROJECT_RECENT_SKILLS_KEY_PREFIX = 'hapi-recent-project-skills-v1:'
export const MAX_PROJECT_RECENT_SKILLS = 3

type RecentSkillsMap = Record<string, number>

function safeParseJson(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

export function getRecentSkills(): RecentSkillsMap {
    if (typeof window === 'undefined') return {}
    try {
        const raw = localStorage.getItem(RECENT_SKILLS_KEY)
        if (!raw) return {}
        const parsed = safeParseJson(raw)
        if (!parsed || typeof parsed !== 'object') return {}

        const record = parsed as Record<string, unknown>
        const result: RecentSkillsMap = {}
        for (const [key, value] of Object.entries(record)) {
            if (typeof key !== 'string' || key.trim().length === 0) continue
            if (typeof value !== 'number' || !Number.isFinite(value)) continue
            result[key] = value
        }
        return result
    } catch {
        return {}
    }
}

export function markSkillUsed(skillName: string): void {
    const name = skillName.trim()
    if (!name) return
    if (typeof window === 'undefined') return

    try {
        const recent = getRecentSkills()
        recent[name] = Date.now()

        const entries = Object.entries(recent)
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_RECENT_SKILLS)

        const next: RecentSkillsMap = Object.fromEntries(entries)
        localStorage.setItem(RECENT_SKILLS_KEY, JSON.stringify(next))
    } catch {
        // Ignore storage errors
    }
}

function getProjectRecentSkillsKey(projectPath: string): string | null {
    const normalizedPath = projectPath.trim().replace(/[\\/]+$/, '') || projectPath.trim()
    if (!normalizedPath) return null
    return `${PROJECT_RECENT_SKILLS_KEY_PREFIX}${encodeURIComponent(normalizedPath)}`
}

export function getProjectRecentSkills(projectPath: string | null | undefined): string[] {
    if (!projectPath || typeof window === 'undefined') return []
    const key = getProjectRecentSkillsKey(projectPath)
    if (!key) return []

    try {
        const parsed = safeParseJson(localStorage.getItem(key) ?? '')
        if (!Array.isArray(parsed)) return []

        return parsed
            .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            .filter((value, index, values) => values.indexOf(value) === index)
            .slice(0, MAX_PROJECT_RECENT_SKILLS)
    } catch {
        return []
    }
}

/**
 * Record a deliberate skill-picker click for one workspace. Autocomplete and
 * passive discovery do not call this function, so "Recent" stays a list of
 * actions the user explicitly chose in that project.
 */
export function markProjectSkillUsed(
    projectPath: string | null | undefined,
    skillName: string
): string[] {
    const name = skillName.trim()
    if (!projectPath || !name || typeof window === 'undefined') return []
    const key = getProjectRecentSkillsKey(projectPath)
    if (!key) return []

    const next = [
        name,
        ...getProjectRecentSkills(projectPath).filter((recentName) => recentName !== name)
    ].slice(0, MAX_PROJECT_RECENT_SKILLS)

    try {
        localStorage.setItem(key, JSON.stringify(next))
    } catch {
        // Recent shortcuts are optional; a full/private storage area must not
        // prevent the selected skill from being used.
    }
    return next
}
