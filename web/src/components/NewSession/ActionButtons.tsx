import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

export function ActionButtons(props: {
    isPending: boolean
    canCreate: boolean
    isDisabled: boolean
    createLabel?: string
    onCancel: () => void
    onCreate: () => void
}) {
    const { t } = useTranslation()

    return (
        <div
            className="fixed inset-x-0 bottom-0 z-20 border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 pb-[calc(var(--app-safe-area-bottom)+0.75rem)] pt-3"
            data-testid="new-session-actions"
        >
            <div className="mx-auto flex w-full max-w-2xl gap-2">
                <Button
                    variant="secondary"
                    onClick={props.onCancel}
                    disabled={props.isDisabled}
                    className="h-12 min-w-0 flex-1 rounded-2xl px-4 text-base"
                >
                    {t('button.cancel')}
                </Button>
                <Button
                    onClick={props.onCreate}
                    disabled={!props.canCreate}
                    aria-busy={props.isPending}
                    className="h-12 min-w-0 flex-1 rounded-2xl px-5 text-base gap-2"
                >
                    {props.isPending ? (
                        <>
                            <Spinner size="sm" label={null} className="text-[var(--app-button-text)]" />
                            {t('newSession.creating')}
                        </>
                    ) : (
                        (props.createLabel ?? t('newSession.create'))
                    )}
                </Button>
            </div>
        </div>
    )
}
