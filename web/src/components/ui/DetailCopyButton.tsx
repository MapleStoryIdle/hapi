import { useState } from 'react'
import { CopyIcon, CheckIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'

export function DetailCopyButton(props: { value: string; label: string; showLabel?: boolean; iconOnly?: boolean }) {
    const { copy, copied } = useCopyToClipboard()
    const { t } = useTranslation()
    const [failed, setFailed] = useState(false)
    return <span className="inline-flex shrink-0 items-center">
        <button type="button" className="chat-detail-control" aria-label={props.label} title={props.label}
            onClick={async () => { setFailed(!await copy(props.value)) }}>
            {props.iconOnly ? <span aria-hidden="true">{copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}</span>
                : copied ? t('terminal.execution.copied') : props.showLabel ? props.label : t('code.copy')}
        </button>
        <span className={failed ? "text-xs text-[var(--app-badge-error-text)]" : "sr-only"} role="status">{failed ? t('terminal.execution.copyFailed') : copied ? t('terminal.execution.copied') : ''}</span>
    </span>
}
