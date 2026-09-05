import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { QuestionAnswerForm, type AnswerQuestion } from './QuestionAnswerForm'
import { isAskUserQuestionToolName, parseAskUserQuestionInput } from './askUserQuestion'
import { isCursorAskQuestionToolName, parseCursorAskQuestionInput } from './cursorAskQuestion'
import { useTranslation } from '@/lib/use-translation'

export function AskUserQuestionFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const permission = props.tool.permission
    if (!permission || permission.status !== 'pending' || !isAskUserQuestionToolName(props.tool.name)) return null
    const stableIds = isCursorAskQuestionToolName(props.tool.name)
    const parsed = stableIds ? parseCursorAskQuestionInput(props.tool.input) : parseAskUserQuestionInput(props.tool.input)
    const questions: AnswerQuestion[] = parsed.questions.map((question, index) => ({
        ...question,
        id: stableIds ? question.id || String(index) : String(index),
        options: question.options.map((option) => ({ ...option, value: stableIds ? option.id || option.label : option.label }))
    }))
    // Preserve the existing free-text fallback for malformed AskUserQuestion input.
    if (questions.length === 0) questions.push({ id: '0', question: t('tool.askUserQuestion.fallback'), multiSelect: false, options: [] })
    return (
        <QuestionAnswerForm
            key={`${props.sessionId}:${props.tool.id}:${permission.id}`}
            questions={questions}
            disabled={props.disabled}
            onDone={props.onDone}
            textPlaceholder={t('tool.askUserQuestion.otherPlaceholder')}
            onSubmit={(selections) => props.api.approvePermission(props.sessionId, permission.id, {
                answers: Object.fromEntries(questions.map((question, index) => [question.id, [
                    ...selections[index].selected,
                    ...(selections[index].text.trim() ? [selections[index].text.trim()] : [])
                ]]))
            })}
        />
    )
}
