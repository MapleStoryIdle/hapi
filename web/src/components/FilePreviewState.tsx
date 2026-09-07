import { FileQuestion, FileSearch, FileWarning, FileX2, HardDrive, LockKeyhole, Unplug, File } from 'lucide-react'
import type { FilePreviewIssue } from '@/lib/file-preview-error'
import { useTranslation } from '@/lib/use-translation'

const ICONS = {
    missing: FileSearch, denied: LockKeyhole, tooLarge: HardDrive, invalid: FileWarning,
    unsupported: FileQuestion, offline: Unplug, unavailable: FileX2, empty: File
}

export function FilePreviewState({ issue, retry, busy = false }: {
    issue: FilePreviewIssue
    retry?: () => void
    busy?: boolean
}) {
    const { t } = useTranslation()
    const Icon = ICONS[issue]
    const canRetry = retry && ['missing', 'invalid', 'offline', 'unavailable'].includes(issue)
    return <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-4 py-8 text-center" role={issue === 'empty' ? 'status' : 'alert'} data-file-preview-state={issue}>
        <span className="flex size-14 items-center justify-center rounded-2xl bg-[var(--app-subtle-bg)] text-[var(--app-hint)]" aria-hidden="true">
            <Icon className="size-7" strokeWidth={1.5} aria-hidden="true" />
        </span>
        <div className="max-w-sm space-y-2">
            <h3 className="text-base font-semibold text-[var(--app-fg)]">{t(`chatPreview.state.${issue}.title`)}</h3>
            <p className="text-sm leading-6 text-[var(--app-hint)]">{t(`chatPreview.state.${issue}.description`)}</p>
        </div>
        {canRetry ? <button type="button" disabled={busy} className="chat-sheet-action chat-sheet-action-secondary mt-1 min-h-11 disabled:opacity-50" onClick={retry}>
            {busy ? t('loading') : t('chatPreview.reload')}
        </button> : null}
    </div>
}
