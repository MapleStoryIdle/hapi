import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { QuestionAnswerForm } from './QuestionAnswerForm'
import { formatRequestUserInputAnswers, isRequestUserInputToolName, parseRequestUserInputInput } from './requestUserInput'
import { useTranslation } from '@/lib/use-translation'

export function RequestUserInputFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const permission = props.tool.permission
    if (!permission || permission.status !== 'pending' || !isRequestUserInputToolName(props.tool.name)) return null
    const { questions } = parseRequestUserInputInput(props.tool.input)
    // No valid protocol IDs: don't invent an answer that the agent cannot use.
    if (questions.length === 0) return null
    return (
        <QuestionAnswerForm
            key={`${props.sessionId}:${props.tool.id}:${permission.id}`}
            questions={questions.map((question) => ({
                ...question,
                multiSelect: false,
                options: question.options.map((option) => ({ ...option, value: option.label }))
            }))}
            disabled={props.disabled}
            onDone={props.onDone}
            autoOpenKey={JSON.stringify(['request-user-input', props.sessionId, props.tool.id, permission.id])}
            textPlaceholder={t('tool.requestUserInput.textPlaceholder')}
            onSubmit={(selections) => props.api.approvePermission(props.sessionId, permission.id, formatRequestUserInputAnswers(
                Object.fromEntries(questions.map((question, index) => [question.id, {
                    selected: selections[index].selected[0] ?? null,
                    userNote: selections[index].text
                }]))
            ))}
        />
    )
}
