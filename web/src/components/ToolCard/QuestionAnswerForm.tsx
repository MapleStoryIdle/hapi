import { useEffect, useRef, useState } from 'react'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { Spinner } from '@/components/Spinner'
import { AskUserQuestionOptionBody, getAskUserQuestionOptionFrameClassName } from './askUserQuestionOptionCard'
import { usePlatform } from '@/hooks/usePlatform'
import { useTranslation } from '@/lib/use-translation'

export type AnswerQuestion = {
    id: string
    question: string
    header?: string | null
    multiSelect: boolean
    options: { value: string; label: string; description: string | null }[]
}
export type QuestionSelection = { selected: string[]; other: boolean; text: string }
const EMPTY_SELECTION: QuestionSelection = { selected: [], other: false, text: '' }

/** Both protocols share interaction; only their wire answer formats differ. */
export function QuestionAnswerForm(props: {
    questions: AnswerQuestion[]
    disabled: boolean
    onSubmit: (answers: QuestionSelection[]) => Promise<unknown>
    onDone: () => void
    textPlaceholder: string
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const [open, setOpen] = useState(true)
    const [step, setStep] = useState(0)
    const [selections, setSelections] = useState<QuestionSelection[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // A double tap must not approve the same request twice.
    const submitting = useRef(false)
    const questionRef = useRef<HTMLDivElement>(null)
    const previousStep = useRef(step)
    const question = props.questions[step]
    const selection = selections[step] ?? EMPTY_SELECTION
    const pureText = question.options.length === 0
    const needsSend = question.multiSelect || pureText || selection.other
    const isLast = step === props.questions.length - 1

    useEffect(() => {
        if (previousStep.current === step) return
        previousStep.current = step
        // After advancing, keyboard users start at the new question, not a removed option.
        questionRef.current?.focus({ preventScroll: true })
        const body = questionRef.current?.closest('[data-question-drawer-body]')
        if (body) body.scrollTop = 0
    }, [step])

    const isAnswered = (answer: QuestionSelection | undefined, index: number) => {
        if (!answer) return false
        if ((answer.other || props.questions[index].options.length === 0) && !answer.text.trim()) return false
        return answer.selected.length > 0 || answer.text.trim().length > 0
    }

    const continueOrSubmit = async (nextSelections: QuestionSelection[]) => {
        if (props.disabled || submitting.current) return
        if (!isAnswered(nextSelections[step], step)) {
            setError(t('tool.selectOption'))
            return
        }
        setError(null)
        if (!isLast) {
            setStep(step + 1)
            return
        }
        const missing = props.questions.findIndex((_, index) => !isAnswered(nextSelections[index], index))
        if (missing !== -1) {
            setStep(missing)
            return
        }
        submitting.current = true
        setLoading(true)
        try {
            await props.onSubmit(nextSelections)
            haptic.notification('success')
            setOpen(false)
            props.onDone()
            // Keep locked after success until the permission update unmounts us.
        } catch (cause) {
            submitting.current = false
            haptic.notification('error')
            setError(cause instanceof Error ? cause.message : t('dialog.error.default'))
            setLoading(false)
        }
    }

    const update = (answer: QuestionSelection) => {
        const next = [...selections]
        next[step] = answer
        setSelections(next)
        setError(null)
        return next
    }

    const chooseOption = (value: string) => {
        if (props.disabled || submitting.current) return
        haptic.selection()
        if (question.multiSelect) {
            const values = new Set(selection.selected)
            if (values.has(value)) values.delete(value)
            else values.add(value)
            update({ ...selection, selected: question.options.filter((option) => values.has(option.value)).map((option) => option.value) })
        } else {
            void continueOrSubmit(update({ selected: [value], other: false, text: '' }))
        }
    }

    const option = (value: string, label: string, description: string | null, other = false) => {
        const checked = other ? selection.other : selection.selected.includes(value)
        return (
            <button
                key={other ? 'other' : `option:${value}`}
                type="button"
                role={question.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={checked}
                disabled={props.disabled || loading}
                className={getAskUserQuestionOptionFrameClassName(checked, 'min-h-11 w-full text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50')}
                onClick={() => {
                    if (!other) return chooseOption(value)
                    haptic.selection()
                    update(question.multiSelect
                        ? { ...selection, other: !selection.other, text: selection.other ? '' : selection.text }
                        : { selected: [], other: true, text: selection.text })
                }}
            >
                <AskUserQuestionOptionBody checked={checked} mode={question.multiSelect ? 'multi' : 'single'} title={label} description={description} interactive />
            </button>
        )
    }

    return (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3">
            <span className="min-w-0 text-sm text-[var(--app-hint)]">{t('tool.waitingForAnswer')}</span>
            <BottomDrawer
                open={open}
                onOpenChange={setOpen}
                busy={loading}
                title={t('tool.answerQuestion')}
                testId="question-answer-form-drawer"
                trigger={<Button type="button" variant="outline" size="sm" disabled={props.disabled || loading}>{t('tool.answerQuestion')}</Button>}
                footer={step > 0 || needsSend || loading ? (
                    <div className="flex min-h-11 items-center justify-between gap-3">
                        {step > 0 ? <Button type="button" variant="outline" disabled={props.disabled || loading} onClick={() => { setStep(step - 1); setError(null) }}>{t('tool.prev')}</Button> : <span />}
                        {needsSend ? (
                            <Button type="button" disabled={props.disabled || loading || !isAnswered(selection, step)} onClick={() => { void continueOrSubmit(selections) }} aria-busy={loading} className="min-h-11 rounded-full px-6">
                                {loading ? <Spinner size="sm" label={null} /> : null}
                                {loading ? t('tool.submitting') : isLast ? t('tool.sendAnswer') : t('tool.next')}
                            </Button>
                        ) : loading ? <span role="status" className="flex items-center gap-2 text-sm text-[var(--app-hint)]"><Spinner size="sm" label={null} />{t('tool.submitting')}</span> : null}
                    </div>
                ) : undefined}
            >
                <div key={question.id}>
                    <div className="mb-3 flex items-center justify-between gap-2 text-xs text-[var(--app-hint)]">
                        <span>{question.header || t('tool.question')}</span>
                        <span className="tabular-nums">{step + 1} / {props.questions.length}</span>
                    </div>
                    <div ref={questionRef} tabIndex={-1} role="heading" aria-level={3} className="mb-4 text-base font-medium outline-none"><MarkdownRenderer standalone content={question.question} /></div>
                    {error ? <p role="alert" className="mb-3 break-words text-sm text-red-600">{error}</p> : null}
                    {!pureText ? (
                        <div className="flex flex-col gap-2" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
                            {question.options.map((item) => option(item.value, item.label, item.description))}
                            {option('', t('tool.other'), t('tool.otherDescription'), true)}
                        </div>
                    ) : null}
                    {pureText || selection.other ? (
                        <textarea
                            aria-label={question.question || t('tool.answerQuestion')}
                            value={selection.text}
                            onChange={(event) => update({ ...selection, text: event.target.value })}
                            disabled={props.disabled || loading}
                            placeholder={props.textPlaceholder}
                            className="mt-3 min-h-[88px] w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-base text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
                        />
                    ) : null}
                </div>
            </BottomDrawer>
        </div>
    )
}
