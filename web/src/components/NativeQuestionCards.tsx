import { createContext, type ReactNode } from 'react'
import { CheckIcon } from '@/components/icons'
import { QuestionIcon } from '@/components/ToolCard/icons'

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
