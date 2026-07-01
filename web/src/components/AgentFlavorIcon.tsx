import ClaudeCodeIcon from '@lobehub/icons/es/ClaudeCode/components/Color'
import CodexIcon from '@lobehub/icons/es/Codex/components/Color'
import CursorIcon from '@lobehub/icons/es/Cursor/components/Mono'
import GeminiCliIcon from '@lobehub/icons/es/GeminiCLI/components/Color'
import KimiIcon from '@lobehub/icons/es/Kimi/components/Color'
import OpenCodeIcon from '@lobehub/icons/es/OpenCode/components/Mono'
import type { IconType } from '@lobehub/icons/es/types'

const FLAVOR_ICONS: Record<string, { Icon: IconType; title: string; colors?: string }> = {
    claude: { Icon: ClaudeCodeIcon, title: 'Claude Code' },
    codex: { Icon: CodexIcon, title: 'Codex' },
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
                className={`inline-flex items-center justify-center overflow-hidden rounded-sm ${icon.colors ?? ''} ${className ?? 'h-4 w-4'}`}
            >
                <Icon className="h-full w-full" focusable="false" size="100%" />
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
