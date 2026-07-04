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
        <div className="flex flex-col gap-2 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1">
            <Button
                onClick={props.onCreate}
                disabled={!props.canCreate}
                aria-busy={props.isPending}
                className="h-12 w-full rounded-2xl px-5 text-base gap-2"
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
            <Button
                variant="secondary"
                onClick={props.onCancel}
                disabled={props.isDisabled}
                className="h-12 w-full rounded-2xl px-4 text-base"
            >
                {t('button.cancel')}
            </Button>
        </div>
    )
}
