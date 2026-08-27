import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { usePlatform } from '@/hooks/usePlatform'
import { usePwaUpdateContext } from '@/lib/pwa-update-context'
import { useTranslation } from '@/lib/use-translation'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function PwaUpdateBanner() {
    const { t } = useTranslation()
    const { needRefresh, reload } = usePwaUpdateContext()
    const { haptic } = usePlatform()
    const [deferred, setDeferred] = useState(false)

    useEffect(() => {
        if (!needRefresh) {
            setDeferred(false)
        }
    }, [needRefresh])

    if (!needRefresh || deferred) {
        return null
    }

    return (
        <Dialog open onOpenChange={() => {}}>
            <DialogContent
                hideClose
                data-testid="pwa-update-prompt"
                className="max-w-sm p-5"
                onEscapeKeyDown={(event) => event.preventDefault()}
                onPointerDownOutside={(event) => event.preventDefault()}
            >
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--app-secondary-bg)] text-[var(--app-link)]">
                    <RefreshCw className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
                </div>
                <DialogHeader className="mt-4 pr-0">
                    <DialogTitle>{t('pwa.update.title')}</DialogTitle>
                    <DialogDescription className="mt-2 leading-5">
                        {t('pwa.update.body')}
                    </DialogDescription>
                </DialogHeader>
                <div className="mt-6 grid grid-cols-2 gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                            haptic.impact('light')
                            setDeferred(true)
                        }}
                    >
                        {t('pwa.update.defer')}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => {
                            haptic.impact('light')
                            reload()
                        }}
                    >
                        {t('pwa.update.reload')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
