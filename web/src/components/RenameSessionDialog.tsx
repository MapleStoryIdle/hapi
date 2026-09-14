import { useState, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { BottomDrawer } from '@/components/ui/BottomDrawer'
import { useTranslation } from '@/lib/use-translation'

type RenameSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    currentName: string
    onRename: (newName: string) => Promise<void>
    isPending: boolean
}

export function RenameSessionDialog(props: RenameSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, currentName, onRename, isPending } = props
    const [name, setName] = useState(currentName)
    const [error, setError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (isOpen) {
            setName(currentName)
            setError(null)
            setTimeout(() => {
                inputRef.current?.focus()
                inputRef.current?.select()
            }, 100)
        }
    }, [isOpen, currentName])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed || trimmed === currentName) {
            onClose()
            return
        }
        setError(null)
        try {
            await onRename(trimmed)
            onClose()
        } catch (err) {
            setError(t('dialog.rename.error'))
        }
    }

    return (
        <BottomDrawer
            open={isOpen}
            onOpenChange={(open) => { if (!open) onClose() }}
            title={t('dialog.rename.title')}
            inputDialog
            busy={isPending}
            testId="rename-session-dialog"
            desktopClassName="max-w-sm"
            footer={(
                <div className="flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onClose}
                        disabled={isPending}
                    >
                        {t('button.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        form="rename-session-form"
                        disabled={isPending || !name.trim()}
                    >
                        {isPending ? t('dialog.rename.saving') : t('button.save')}
                    </Button>
                </div>
            )}
        >
            <form id="rename-session-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
                <input
                    ref={inputRef}
                    data-drawer-initial-focus
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('dialog.rename.placeholder')}
                    className="ios-form-control w-full px-3 py-2.5 text-base"
                    disabled={isPending}
                    maxLength={255}
                />

                {error ? (
                    <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {error}
                    </div>
                ) : null}
            </form>
        </BottomDrawer>
    )
}
