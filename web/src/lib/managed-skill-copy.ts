import type { I18nContextValue, Locale } from '@/lib/i18n-context'

type Translate = I18nContextValue['t']

export function managedSkillCopy(
    id: string,
    fallback: { name: string; description?: string; descriptions?: Partial<Record<Locale, string>> },
    t: Translate,
    locale: Locale
): { name: string; description?: string } {
    const keys = {
        'public-share': ['skills.catalog.publicShare.name', 'skills.catalog.publicShare.description'],
        'agent-team': ['skills.catalog.agentTeam.name', 'skills.catalog.agentTeam.description'],
        'git-merge-current-to-target': ['skills.catalog.gitMergeCurrentToTarget.name', 'skills.catalog.gitMergeCurrentToTarget.description']
    } as const
    const copy = keys[id as keyof typeof keys]
    if (copy) return { name: t(copy[0]), description: t(copy[1]) }
    return { name: fallback.name, description: fallback.descriptions?.[locale] ?? fallback.description }
}
