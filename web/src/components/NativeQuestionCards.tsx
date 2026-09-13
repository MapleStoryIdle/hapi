import { createContext, type ReactNode, useState } from 'react'
import { CheckIcon } from '@/components/icons'
import { QuestionIcon } from '@/components/ToolCard/icons'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/lib/use-translation'

/** Only native threads provide replacements; managed sessions stay unchanged. */
export const NativeQuestionCards = createContext<ReadonlyMap<string, ReactNode>>(new Map())

export function NativeQuestionSummary(props: {
    questions: readonly { id: string; question: string; options?: readonly (string | { label: string })[] | null }[]
    answers?: Record<string, string[]>
    status: string
    pending?: boolean
}) {
    const hasAnswers = props.questions.some((question) => props.answers?.[question.id]?.length)
    return <div className="min-w-0 overflow-hidden rounded-[20px] border border-[var(--app-border)] bg-[var(--app-tool-card-bg)] text-[var(--app-fg)]" data-testid="native-question-summary" data-pending={props.pending || undefined}>
        <div className="flex min-h-11 items-center gap-2 bg-[var(--app-subtle-bg)] px-3 py-2">
            <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-[var(--app-bg)] ${hasAnswers ? 'text-emerald-600 dark:text-emerald-400' : 'text-[var(--app-link)]'}`}>
                {hasAnswers ? <CheckIcon className="h-4 w-4" /> : <QuestionIcon className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1 text-xs font-medium leading-5" role="status">{props.status}</div>
            {props.pending ? <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0 text-[var(--app-link)]"><path d="m6 3 5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : null}
        </div>
        <div className="px-4">
            {props.questions.map((question, index) => <div key={question.id} className="border-t border-[var(--app-border)] py-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    {props.questions.length > 1 ? <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--app-hint)]">{String(index + 1).padStart(2, '0')}</span> : null}
                    <div className="min-w-0 line-clamp-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm font-normal leading-5">{question.question}</div>
                </div>
                {props.pending ? question.options?.map((option) => typeof option === 'string' ? option : option.label)
                    .filter((label) => /[（(]\s*(?:recommended|推荐)\s*[)）]/i.test(label))
                    .map((label, optionIndex) => <div key={optionIndex} className="mt-2 line-clamp-2 [overflow-wrap:anywhere] text-sm leading-5 text-[var(--app-link)]">{label}</div>) : null}
                {props.answers?.[question.id]?.map((answer, answerIndex) => <div key={answerIndex} className="mt-2 border-l-2 border-[var(--app-link)] pl-3 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-[var(--app-link)]">{answer}</div>)}
            </div>)}
        </div>
    </div>
}

export function NativeQuestionHistory(props: {
    questions: readonly {
        id: string
        question: string
        options?: readonly (string | { label: string; description?: string | null })[] | null
    }[]
    answers?: Record<string, string[]>
    status: string
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)

    return (
        <BottomDrawer
            open={open}
            onOpenChange={setOpen}
            title={t('questionAnswer.title')}
            subtitle={t('questionAnswer.completeOptions')}
            testId="native-question-history-drawer"
            trigger={(
                <button
                    type="button"
                    className="w-full rounded-[20px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    aria-label={t('questionAnswer.viewOptions')}
                >
                    <NativeQuestionSummary questions={props.questions} answers={props.answers} status={props.status} />
                </button>
            )}
        >
            <div className="divide-y divide-[var(--app-divider)]">
                {props.questions.map((question, index) => {
                    const answers = props.answers?.[question.id] ?? []
                    const options = (question.options ?? []).map((option) => typeof option === 'string'
                        ? { label: option, description: null }
                        : { label: option.label, description: option.description ?? null })
                    const optionLabels = new Set(options.map((option) => option.label))
                    const customAnswers = answers.filter((answer) => !optionLabels.has(answer))
                    return (
                        <section key={question.id} className="py-4 first:pt-0 last:pb-0">
                            <div className="mb-3 flex items-start gap-2">
                                <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] px-1 text-[10px] font-semibold tabular-nums text-[var(--app-hint)]">{index + 1}</span>
                                <p className="min-w-0 whitespace-pre-wrap break-words text-sm font-semibold leading-6 text-[var(--app-fg)]">{question.question}</p>
                            </div>
                            <div className="chat-sheet-group flex flex-col gap-1 p-1" role="list" aria-label={t('questionAnswer.completeOptions')}>
                                {options.map((option) => {
                                    const selected = answers.includes(option.label)
                                    return <div key={option.label} role="listitem" data-native-question-option data-selected={selected ? 'true' : 'false'} className={cn('flex min-w-0 items-start gap-3 rounded-[14px] border px-3 py-3', selected ? 'border-[var(--app-border)] bg-[var(--app-subtle-bg)]' : 'border-transparent')}>
                                        <span aria-hidden="true" className={cn('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border', selected ? 'border-[var(--app-button)] bg-[var(--app-button)] text-[var(--app-button-text)]' : 'border-[var(--app-border)]')}>
                                            {selected ? <CheckIcon className="h-3 w-3" /> : null}
                                        </span>
                                        <span className="min-w-0 flex-1">
                                            <span className="block break-words text-sm font-medium leading-6 text-[var(--app-fg)]">{option.label}</span>
                                            {option.description ? <span className="mt-1 block break-words text-xs leading-5 text-[var(--app-hint)]">{option.description}</span> : null}
                                        </span>
                                        {selected ? <span className="shrink-0 pt-1 text-xs font-medium text-[var(--app-hint)]">{t('questionAnswer.selected')}</span> : null}
                                    </div>
                                })}
                            </div>
                            {customAnswers.map((answer) => <div key={answer} className="chat-sheet-group mt-3 whitespace-pre-wrap break-words px-4 py-3 text-sm leading-6 text-[var(--app-fg)]">{answer}</div>)}
                        </section>
                    )
                })}
            </div>
        </BottomDrawer>
    )
}
