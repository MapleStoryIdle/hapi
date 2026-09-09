import { useEffect, useState } from 'react'
import type { NativeCodexUserInput as PendingInput } from '@hapi/protocol/codexSessionControl'
import type { ApiClient } from '@/api/client'
import { QuestionAnswerForm } from '@/components/ToolCard/QuestionAnswerForm'
import { useTranslation } from '@/lib/use-translation'
import { NativeQuestionSummary } from './NativeQuestionCards'

/** The form owns a Portal drawer; its reopen control never moves the composer. */
export function NativeCodexUserInput(props: {
    api: ApiClient
    machineId: string
    sessionId: string
    input: PendingInput
    onRefresh: () => void
    resolved?: boolean
}) {
    const { t } = useTranslation()
    const [answered, setAnswered] = useState(false)
    const [answers, setAnswers] = useState<Record<string, string[]>>({})
    useEffect(() => {
        if (props.resolved) setAnswered(true)
    }, [props.resolved])
    if (answered || props.resolved) return <NativeQuestionSummary questions={props.input.questions} answers={answers} status={t('recentCodex.input.resolved')} />
    return (
        <div data-testid="native-user-input">
            <QuestionAnswerForm
                messageCard
                autoOpenKey={JSON.stringify([props.machineId, props.sessionId, props.input.turnId, props.input.itemId])}
                questions={props.input.questions.map((question) => ({
                    id: question.id,
                    question: question.question,
                    multiSelect: false,
                    options: (question.options ?? []).map((option) => ({
                        value: option.label,
                        label: option.label,
                        description: option.description ?? null
                    }))
                }))}
                disabled={false}
                textPlaceholder={t('tool.requestUserInput.textPlaceholder')}
                onDone={() => { setAnswered(true); props.onRefresh() }}
                onSubmit={async (selections) => {
                    const result = await props.api.controlCodexSession(props.sessionId, props.machineId, {
                        action: 'answerUserInput',
                        expectedTurnId: props.input.turnId,
                        requestId: props.input.itemId,
                        answers: Object.fromEntries(props.input.questions.map((question, index) => [question.id, {
                            answers: [...selections[index].selected, ...(selections[index].text.trim() ? [selections[index].text.trim()] : [])]
                        }]))
                    })
                    // An exact request that has already been resolved elsewhere
                    // is not a failed answer to retry. onDone closes/refetches it.
                    if (!result.success && result.code !== 'turn_changed') throw new Error(t('recentCodex.input.failed'))
                    if (result.success) setAnswers(Object.fromEntries(props.input.questions.map((question, index) => [question.id,
                        [...selections[index].selected, ...(selections[index].text.trim() ? [selections[index].text.trim()] : [])]
                    ])))
                }}
            />
        </div>
    )
}
