import type { I18nContextValue } from '@/lib/i18n-context'

type Translate = I18nContextValue['t']

export function managedSkillCopy(
    id: string,
    fallback: { name: string; description?: string },
    t: Translate
): { name: string; description?: string } {
    if (id === 'public-share') {
        return {
            name: t('skills.catalog.publicShare.name'),
            description: t('skills.catalog.publicShare.description')
        }
    }
    return fallback
}
