import ClaudeIcon from '@lobehub/icons/es/Claude/components/Mono'
import CursorIcon from '@lobehub/icons/es/Cursor/components/Mono'
import GeminiCliIcon from '@lobehub/icons/es/GeminiCLI/components/Color'
import KimiIcon from '@lobehub/icons/es/Kimi/components/Color'
import OpenCodeIcon from '@lobehub/icons/es/OpenCode/components/Mono'
import OpenAIIcon from '@lobehub/icons/es/OpenAI/components/Mono'
import type { IconType } from '@lobehub/icons/es/types'

const FLAVOR_ICONS: Record<string, { Icon: IconType; title: string; colors?: string; shape?: string; iconClassName?: string }> = {
    claude: {
        Icon: ClaudeIcon,
        title: 'Claude Code',
        colors: 'text-[#D97757]'
    },
    codex: { Icon: OpenAIIcon, title: 'Codex' },
    cursor: { Icon: CursorIcon, title: 'Cursor', colors: 'text-[var(--app-fg)]' },
    gemini: { Icon: GeminiCliIcon, title: 'Gemini CLI' },
    kimi: { Icon: KimiIcon, title: 'Kimi' },
    opencode: { Icon: OpenCodeIcon, title: 'OpenCode', colors: 'text-[var(--app-fg)]' },
}

const TEXT_FALLBACK_BADGES: Record<string, { label: string; colors: string }> = {
    pi: {
        label: 'Pi',
        colors: 'bg-[#5b21b6] text-white',
    },
}

const UNKNOWN_FLAVOR_BADGE = {
    label: 'Un',
    colors: 'bg-[var(--app-secondary-bg)] text-[var(--app-hint)]',
}

export function AgentFlavorIcon({ flavor, className }: { flavor?: string | null; className?: string }) {
    const normalized = (flavor ?? '').trim().toLowerCase()
    const icon = FLAVOR_ICONS[normalized]

    if (icon) {
        const Icon = icon.Icon

        return (
            <span
                aria-hidden="true"
                title={icon.title}
                className={`inline-flex items-center justify-center overflow-hidden ${icon.shape ?? 'rounded-sm'} ${icon.colors ?? ''} ${className ?? 'h-4 w-4'}`}
            >
                <Icon className={icon.iconClassName ?? 'h-full w-full'} focusable="false" size="100%" />
            </span>
        )
    }

    const badge = TEXT_FALLBACK_BADGES[normalized] ?? UNKNOWN_FLAVOR_BADGE

    return (
        <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-sm text-[8px] font-semibold leading-none ${badge.colors} ${className ?? 'h-4 w-4'}`}
        >
            {badge.label}
        </span>
    )
}

export function AgentFlavorStatusIcon({
    flavor,
    className,
    statusClassName,
    showStatus
}: {
    flavor?: string | null
    className?: string
    statusClassName?: string
    showStatus?: boolean
}) {
    return (
        <span className={`relative inline-flex shrink-0 items-center justify-center ${className ?? 'h-5 w-5'}`}>
            <AgentFlavorIcon flavor={flavor} className="h-full w-full" />
            {showStatus ? (
                <span
                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-bg)] ${statusClassName ?? 'bg-[#34C759]'}`}
                    aria-hidden="true"
                />
            ) : null}
        </span>
    )
}
