import { ChatDetailDialog } from '@/components/ui/ChatDetailDialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

export type UriConfirmDialogProps = {
    open: boolean
    url: string
    scheme: string
    onCancel: () => void
    onOpen: () => void
    onAlwaysAllow: (scheme: string) => void
}

/** Same sheet as message details; each navigation permission remains explicit. */
export function UriConfirmDialog(props: UriConfirmDialogProps) {
    const { open, url, scheme, onCancel, onOpen, onAlwaysAllow } = props
    const { t } = useTranslation()
    const schemePrefix = `${scheme}:`
    const urlRemainder = url.startsWith(schemePrefix) ? url.slice(schemePrefix.length) : url

    return (
        <ChatDetailDialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel() }}
            title={t('dialog.uri.title')} subtitle={t('dialog.uri.description')} desktopClassName="max-w-md"
            testId="uri-confirm-drawer"
            footer={
                <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-2 gap-3">
                        <Button type="button" className="chat-sheet-action chat-sheet-action-secondary" onClick={onCancel}>
                            {t('button.cancel')}
                        </Button>
                        <Button type="button" className="chat-sheet-action chat-sheet-action-primary" onClick={onOpen}>
                            {t('dialog.uri.open')}
                        </Button>
                    </div>
                    <Button type="button" className="chat-sheet-action chat-sheet-action-quiet" onClick={() => onAlwaysAllow(scheme)}>
                        {t('dialog.uri.alwaysAllow', { scheme })}
                    </Button>
                </div>
            }>
            <div className="chat-sheet-group px-4 py-3 font-mono text-sm [overflow-wrap:anywhere]">
                <span className="font-semibold text-[var(--app-link)]">{schemePrefix}</span>
                <span className="text-[var(--app-fg)]">{urlRemainder}</span>
            </div>
        </ChatDetailDialog>
    )
}
