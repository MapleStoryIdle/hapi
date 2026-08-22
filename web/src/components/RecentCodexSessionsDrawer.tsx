import * as Dialog from '@radix-ui/react-dialog'
import { CloseIcon } from '@/components/icons'
import { RecentCodexSessions } from '@/components/RecentCodexSessions'
import type { ApiClient } from '@/api/client'
import type { CodexLocalSessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

/** A compact, left-anchored home for runner-local Codex transcript history. */
export function RecentCodexSessionsDrawer(props: {
    api: ApiClient
    machineId: string | null
    open: boolean
    onOpenChange: (open: boolean) => void
    onOpenSession: (session: CodexLocalSessionSummary) => void
}) {
    const { t } = useTranslation()

    return (
        <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/25 backdrop-blur-[1px]" />
                <Dialog.Content
                    className="fixed inset-y-0 left-0 z-50 flex w-[min(24rem,80vw)] max-w-none flex-col border-r border-[var(--app-border)] bg-[var(--app-bg)] pb-[var(--app-safe-area-bottom)] pt-[var(--app-safe-area-top)] shadow-[18px_0_50px_rgba(15,23,42,0.16)] outline-none"
                    aria-describedby={undefined}
                >
                    <Dialog.Title className="sr-only">{t('recentCodex.title')}</Dialog.Title>
                    <Dialog.Close
                        className="absolute right-3 top-[calc(var(--app-safe-area-top)+12px)] z-10 flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                        aria-label={t('button.close')}
                    >
                        <CloseIcon className="h-4 w-4" />
                    </Dialog.Close>
                    <RecentCodexSessions
                        api={props.api}
                        machineId={props.machineId}
                        onOpen={props.onOpenSession}
                    />
                    <Dialog.Close className="mx-4 mb-3 flex h-10 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] text-sm font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] sm:hidden">
                        {t('button.close')}
                    </Dialog.Close>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
