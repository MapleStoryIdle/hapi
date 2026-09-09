import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { NativeAsyncInput } from '@/chat/nativeAsyncInput'
import { QuestionAnswerForm } from '@/components/ToolCard/QuestionAnswerForm'
import { useTranslation } from '@/lib/use-translation'
import { NativeQuestionSummary } from './NativeQuestionCards'
import { parseUserMessageQuestionReply } from '@/chat/questionAnswers'

/** Desktop async questions receive ordinary user-message replies, not
 * SHAPI permission approvals. Never target /permissions for these calls. */
export function NativeAsyncUserInput(props: {
    api: ApiClient
    sessionId: string
    machineId: string
    input: NativeAsyncInput
    alreadySaved?: boolean
    queuedReply?: string
    autoOpen?: boolean
    onRefresh: () => void
}) {
    const { t } = useTranslation()
    const [submitted, setSubmitted] = useState(false)
    const [answers, setAnswers] = useState<Record<string, string[]>>({})
    const receiptId = `native-answer:${props.input.callId}`
    const savedAnswers = Object.fromEntries((parseUserMessageQuestionReply(props.queuedReply ?? '')?.items ?? [])
        .filter((item) => item.questionItemId && props.input.questions.some((q) => q.id === item.questionItemId))
        .map((item) => [item.questionItemId!, item.answers]))
    return (
        <div data-testid="native-async-user-input">
            {props.input.resolved || submitted || props.alreadySaved ? <NativeQuestionSummary questions={props.input.questions} answers={{ ...savedAnswers, ...answers, ...props.input.answers }} status={t(props.input.resolved ? 'recentCodex.input.resolved' : 'recentCodex.input.saved')} /> : (
                <QuestionAnswerForm
                    key={props.input.questions.filter((question) => !props.input.answers?.[question.id]?.length).map((question) => question.id).join(':')}
                    messageCard
                    autoOpenKey={props.autoOpen === false ? undefined : JSON.stringify([props.machineId, props.sessionId, props.input.callId])}
                    questions={props.input.questions.filter((question) => !props.input.answers?.[question.id]?.length).map((question) => ({
                        ...question,
                        multiSelect: false,
                        options: question.options.map((label) => ({ value: label, label, description: null }))
                    }))}
                    disabled={false}
                    textPlaceholder={t('tool.requestUserInput.textPlaceholder')}
                    onDone={() => { setSubmitted(true); props.onRefresh() }}
                    onSubmit={async (selections) => {
                        const body = props.input.questions.filter((question) => !props.input.answers?.[question.id]?.length).map((question, index) => ({
                            questionItemId: question.id,
                            question: question.question,
                            answer: [...selections[index].selected, selections[index].text.trim()].filter(Boolean).join('\n')
                        }))
                        const result = await props.api.sendCodexSessionMessage(props.sessionId, {
                            machineId: props.machineId,
                            message: `<send_user_message_question_reply>${JSON.stringify(body)}</send_user_message_question_reply>`,
                            clientMessageId: receiptId
                        })
                        if (!result.success) throw new Error(t('recentCodex.input.failed'))
                        setAnswers(Object.fromEntries(body.map((item) => [item.questionItemId, [item.answer]])))
                    }}
                />
            )}
        </div>
    )
}
