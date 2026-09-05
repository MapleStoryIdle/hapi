import { useState } from 'react'
import type { QuestionAnswerItem, QuestionAnswerPresentation } from '@/chat/questionAnswers'
import { CheckIcon } from '@/components/icons'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

function DetailsIcon() {
    return (
        <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" aria-hidden="true">
            <path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    )
}

function getSelectedAnswerSummary(answer: QuestionAnswerPresentation): {
    text: string
    hiddenCount: number
    total: number
} {
    const selected = answer.items.flatMap((item) => item.answers)
    const visible = selected.slice(0, 2)

    return {
        text: visible.join(' · '),
        hiddenCount: Math.max(0, selected.length - visible.length),
        total: selected.length
    }
}

function SelectedMark(props: { selected: boolean }) {
    return props.selected ? (
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)]" aria-hidden="true">
            <CheckIcon className="h-3 w-3" />
        </span>
    ) : (
        <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-[var(--app-border)]" aria-hidden="true" />
    )
}

function DetailOption(props: {
    label: string
    description: string | null
    selected: boolean
}) {
    const { t } = useTranslation()

    return (
        <div
            role="listitem"
            className={cn(
                'flex min-w-0 items-start gap-3 rounded-[16px] border px-3 py-3',
                props.selected
                    ? 'border-[var(--app-border)] bg-[var(--app-subtle-bg)]'
                    : 'border-transparent bg-transparent'
            )}
            data-question-answer-option
            data-selected={props.selected ? 'true' : 'false'}
        >
            <SelectedMark selected={props.selected} />
            <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium leading-6 text-[var(--app-fg)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6">
                    <MarkdownRenderer standalone content={props.label} />
                </div>
                {props.description ? (
                    <div className="mt-1 break-words text-xs leading-5 text-[var(--app-hint)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-5">
                        <MarkdownRenderer standalone content={props.description} />
                    </div>
                ) : null}
            </div>
            {props.selected ? (
                <span className="shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--app-hint)]">
                    {t('questionAnswer.selected')}
                </span>
            ) : null}
        </div>
    )
}

function QuestionAnswerDetailItem(props: { item: QuestionAnswerItem; index: number }) {
    const { t } = useTranslation()
    const options = props.item.options ?? []
    const hasOriginalOptions = options.length > 0
    const knownOptionLabels = new Set(options.map((option) => option.label))
    const customAnswers = hasOriginalOptions
        ? props.item.answers.filter((answer) => !knownOptionLabels.has(answer))
        : []
    const displayOptions = hasOriginalOptions
        ? options
        : props.item.answers.map((answer) => ({
            label: answer,
            description: null,
            selected: true
        }))

    return (
        <section className="border-b border-[var(--app-divider)] py-4 first:pt-0 last:border-b-0 last:pb-0" data-question-answer-detail-item>
            <div className="mb-3 flex items-start gap-2">
                <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] px-1 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]">
                    {props.index + 1}
                </span>
                <div className="min-w-0 break-words text-sm font-semibold leading-6 text-[var(--app-fg)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6">
                    {props.item.question ? (
                        <MarkdownRenderer standalone content={props.item.question} />
                    ) : (
                        t('questionAnswer.selectionNumber', { number: props.index + 1 })
                    )}
                </div>
            </div>

            <div className="flex flex-col gap-1" role="list" aria-label={t('questionAnswer.completeOptions')}>
                {displayOptions.map((option) => (
                    <DetailOption
                        key={`${option.label}:${option.description ?? ''}`}
                        label={option.label}
                        description={option.description}
                        selected={option.selected}
                    />
                ))}
            </div>

            {customAnswers.length > 0 ? (
                <div className="mt-3 rounded-[16px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-3" data-question-answer-custom>
                    <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--app-hint)]">
                        {t('questionAnswer.additionalAnswer')}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        {customAnswers.map((answer) => (
                            <div key={answer} className="break-words text-sm leading-6 text-[var(--app-fg)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6">
                                <MarkdownRenderer standalone content={answer} />
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </section>
    )
}

/** A historical answer stays read-only; show the question and choice together. */
export function QuestionAnswerBubble(props: { answer: QuestionAnswerPresentation }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const summary = getSelectedAnswerSummary(props.answer)
    const title = t('questionAnswer.title')
    const summaryText = summary.hiddenCount > 0 ? `${summary.text} +${summary.hiddenCount}` : summary.text

    return (
        <div className="w-full min-w-0 max-w-full" data-question-answer-bubble>
            <BottomDrawer
                open={open}
                onOpenChange={setOpen}
                title={title}
                subtitle={t('questionAnswer.completeOptions')}
                testId="question-answer-details-drawer"
                trigger={(
                    <button
                        type="button"
                        data-testid="question-answer-toggle"
                        aria-label={`${t('questionAnswer.viewOptions')}: ${summaryText}`}
                        className="group flex w-full min-w-0 items-start gap-3 rounded-[20px] border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] px-3.5 py-3 text-left shadow-none transition-colors hover:bg-[var(--app-tool-card-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-emerald-600 dark:text-emerald-400" data-question-answer-summary-mark aria-hidden="true">
                            <CheckIcon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--app-hint)]">{title}</span>
                            {props.answer.items.map((item, index) => (
                                <span key={index} className="mt-2 block first:mt-0" data-question-answer-summary-item>
                                    {item.question ? <span className="block whitespace-pre-wrap break-words text-xs leading-5 text-[var(--app-hint)]">{item.question}</span> : null}
                                    <span className="mt-0.5 block whitespace-pre-wrap break-words text-sm font-semibold leading-6 text-[var(--app-fg)]">{item.answers.join(' · ')}</span>
                                </span>
                            ))}
                        </span>
                        <span className="mt-1 shrink-0 text-[var(--app-hint)]"><DetailsIcon /></span>
                    </button>
                )}
            >
                {props.answer.items.map((item, index) => (
                    <QuestionAnswerDetailItem key={`${item.question ?? 'selection'}:${index}`} item={item} index={index} />
                ))}
            </BottomDrawer>
        </div>
    )
}
