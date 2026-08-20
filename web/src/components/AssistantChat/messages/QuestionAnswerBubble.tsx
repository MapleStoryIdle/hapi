import * as Dialog from '@radix-ui/react-dialog'
import type { QuestionAnswerItem, QuestionAnswerPresentation } from '@/chat/questionAnswers'
import { CheckIcon, CloseIcon } from '@/components/icons'
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
                    <MarkdownRenderer content={props.label} />
                </div>
                {props.description ? (
                    <div className="mt-1 break-words text-xs leading-5 text-[var(--app-hint)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-5">
                        <MarkdownRenderer content={props.description} />
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
                        <MarkdownRenderer content={props.item.question} />
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
                                <MarkdownRenderer content={answer} />
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </section>
    )
}

/**
 * A completed question is a historical record, not an editable form. Keep the
 * chat line compact, then reveal the original option set in a portal drawer
 * when the user needs the full context for a past choice.
 */
export function QuestionAnswerBubble(props: { answer: QuestionAnswerPresentation }) {
    const { t } = useTranslation()
    const summary = getSelectedAnswerSummary(props.answer)
    const title = t('questionAnswer.title')
    const summaryText = summary.hiddenCount > 0
        ? `${summary.text} +${summary.hiddenCount}`
        : summary.text

    return (
        <Dialog.Root>
            <div className="w-full min-w-0 max-w-full" data-question-answer-bubble>
                <Dialog.Trigger asChild>
                    <button
                        type="button"
                        data-testid="question-answer-toggle"
                        aria-label={`${t('questionAnswer.viewOptions')}: ${summaryText}`}
                        className="group flex w-full min-w-0 items-center gap-3 rounded-[20px] border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] px-3.5 py-3 text-left shadow-none transition-colors hover:bg-[var(--app-tool-card-hover-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--app-subtle-bg)] text-emerald-600 dark:text-emerald-400"
                            data-question-answer-summary-mark
                            aria-hidden="true"
                        >
                            <CheckIcon className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--app-hint)]">
                                {title}
                            </span>
                            <span className="mt-0.5 block truncate text-sm font-semibold leading-5 text-[var(--app-fg)]">
                                {summaryText}
                            </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-[var(--app-hint)]">
                            <span className="hidden text-[10px] font-medium sm:inline">
                                {t('questionAnswer.selectedCount', { count: summary.total })}
                            </span>
                            <DetailsIcon />
                        </span>
                    </button>
                </Dialog.Trigger>
            </div>

            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/35" />
                <Dialog.Content
                    aria-describedby={undefined}
                    data-testid="question-answer-details-drawer"
                    className="fixed inset-x-0 bottom-0 z-[61] flex max-h-[min(80dvh,46rem)] flex-col overflow-hidden rounded-t-[28px] border-x border-t border-[var(--app-border)] bg-[var(--app-dialog-bg)] pb-[max(var(--app-safe-area-bottom),0.75rem)] shadow-[0_-18px_48px_rgba(15,23,42,0.22)] animate-slide-up outline-none motion-reduce:animate-none sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(34rem,48vw)] sm:rounded-none sm:border-y-0 sm:border-r-0 sm:border-l sm:pb-0 sm:shadow-[-18px_0_48px_rgba(15,23,42,0.18)]"
                >
                    <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--app-border)] sm:hidden" aria-hidden="true" />

                    <header className="flex shrink-0 items-start gap-3 border-b border-[var(--app-border)] px-5 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-[max(var(--app-safe-area-top),1.25rem)]">
                        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--app-subtle-bg)] text-[var(--app-fg)]" aria-hidden="true">
                            <CheckIcon className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <Dialog.Title className="text-base font-bold text-[var(--app-fg)]">
                                {title}
                            </Dialog.Title>
                            <p className="mt-0.5 text-xs leading-5 text-[var(--app-hint)]">
                                {t('questionAnswer.completeOptions')}
                            </p>
                        </div>
                        <Dialog.Close
                            type="button"
                            aria-label={t('button.close')}
                            className="touch-manipulation -mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        >
                            <CloseIcon className="h-4 w-4" />
                        </Dialog.Close>
                    </header>

                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(var(--app-safe-area-bottom),1.25rem)] pt-4 sm:px-6 sm:pb-6">
                        {props.answer.items.map((item, index) => (
                            <QuestionAnswerDetailItem key={`${item.question ?? 'selection'}:${index}`} item={item} index={index} />
                        ))}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
