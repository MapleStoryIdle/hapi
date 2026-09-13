import type { MouseEvent } from 'react'
import { cn } from '@/lib/utils'
import { MessageTimestamp } from '@/components/AssistantChat/messages/MessageTimestamp'
import type { UsageData } from '@/chat/types'
import { useTranslation } from '@/lib/use-translation'

function formatCompactTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
    return value.toLocaleString()
}

export function getTurnUsageDisplay(usage: UsageData | undefined): {
    total: string
    input: string
    output: string
    cachePercent: number | null
} | null {
    if (!usage) return null
    const input = Math.max(0, usage.input_tokens)
    const output = Math.max(0, usage.output_tokens)
    const cached = Math.max(0, usage.cache_read_input_tokens ?? 0)
    return {
        total: formatCompactTokenCount(input + output),
        input: formatCompactTokenCount(input),
        output: formatCompactTokenCount(output),
        cachePercent: input > 0 ? Math.min(100, Math.round(cached / input * 100)) : null
    }
}

export function shouldIgnoreMessageDetailsToggle(event: MouseEvent<HTMLElement>): boolean {
    const target = event.target
    if (!(target instanceof Element)) return false

    if (target.closest('button,a,input,textarea,select,summary,[role="button"],[role="link"],[data-message-details-ignore]')) {
        return true
    }

    const selection = window.getSelection()
    return Boolean(selection?.toString().trim())
}

export function MessageDetailsFooter(props: {
    visible: boolean
    invokedAt?: number | null
    durationMs?: number
    usage?: UsageData
    model?: string | null
    turnCount?: number
    className?: string
    align?: 'left' | 'right'
    showUsage?: boolean
}) {
    const { t } = useTranslation()
    if (!props.visible) return null

    const align = props.align ?? 'left'
    const usage = props.showUsage === false ? null : getTurnUsageDisplay(props.usage)

    return (
        <>
            <div className={cn(
                'mt-2 flex items-center gap-2',
                align === 'right' ? 'justify-end' : 'justify-start'
            )}>
                <MessageTimestamp className="text-[10px] leading-none text-[var(--app-hint)]" />
                {usage ? (
                    <span className="text-[10px] leading-none text-[var(--app-hint)]">
                        · {t('message.usage.turnTotal', { value: usage.total })}
                    </span>
                ) : null}
                {props.model ? <span className="text-[10px] leading-none text-[var(--app-hint)]">· {props.model}</span> : null}
                {typeof props.durationMs === 'number' && props.durationMs >= 0 ? (
                    <span className="text-[10px] leading-none text-[var(--app-hint)]">
                        · {t('message.details.duration', { value: (props.durationMs / 1000).toFixed(1) })}
                    </span>
                ) : null}
                {typeof props.turnCount === 'number' && props.turnCount >= 2 ? (
                    <span className="text-[10px] leading-none text-[var(--app-hint)]">
                        · {t('message.details.turns', { value: props.turnCount })}
                    </span>
                ) : null}
            </div>
            {usage ? (
                <div className={cn(
                    'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] leading-tight text-[var(--app-hint)]',
                    align === 'right' ? 'justify-end' : 'justify-start'
                )}>
                    <span>{t('message.usage.input', { value: usage.input })}</span>
                    <span>{t('message.usage.output', { value: usage.output })}</span>
                    {usage.cachePercent !== null ? (
                        <span>{t('message.usage.cache', { value: usage.cachePercent })}</span>
                    ) : null}
                </div>
            ) : null}
        </>
    )
}
