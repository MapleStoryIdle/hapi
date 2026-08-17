import type { QuestionAnswerPresentation } from '@/chat/questionAnswers'
import { CheckIcon } from '@/components/icons'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { useTranslation } from '@/lib/use-translation'

export function QuestionAnswerBubble(props: { answer: QuestionAnswerPresentation }) {
    const { t } = useTranslation()

    return (
        <div className="flex min-w-0 flex-col gap-3" data-question-answer-bubble>
            <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.01em] text-[var(--app-chat-user-chip-fg)]">
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--app-chat-user-chip-bg)]" aria-hidden="true">
                    <CheckIcon className="h-2.5 w-2.5" />
                </span>
                <span>{t('questionAnswer.title')}</span>
            </div>

            {props.answer.items.map((item, index) => (
                <div key={index} className="min-w-0 border-l-2 border-[var(--app-chat-user-chip-bg)] pl-3" data-question-answer-item>
                    {item.question ? (
                        <div className="text-xs leading-5 text-[var(--app-chat-user-chip-fg)] opacity-75 [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-5">
                            <MarkdownRenderer content={item.question} />
                        </div>
                    ) : null}
                    <div className="mt-1.5 flex min-w-0 flex-col gap-1">
                        {item.answers.map((answer) => (
                            <div key={answer} className="min-w-0 break-words text-sm font-semibold leading-6 text-[var(--app-chat-user-fg)] [&_.aui-md]:text-inherit [&_.aui-md-p]:my-0 [&_.aui-md-p]:leading-6" data-question-answer-choice>
                                <MarkdownRenderer content={answer} />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    )
}
