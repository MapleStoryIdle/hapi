import { Check, Link, Terminal } from 'lucide-react'
import { useState } from 'react'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { monitorWebhookCurl, monitorWebhookUrl } from './webhookCommand'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Credentials remain in component memory only, never query/localStorage caches. */
export function MonitorTokenReveal(props: { token: string; baseUrl: string; t: Translate }) {
    const { copy, copied } = useCopyToClipboard()
    const [copiedKind, setCopiedKind] = useState<'url' | 'curl'>('url')
    const origin = props.baseUrl || window.location.origin
    const curl = monitorWebhookCurl(origin, props.token, 'YOUR_PROMPT')
    const [copyFailed, setCopyFailed] = useState(false)
    const copyValue = async (kind: 'url' | 'curl') => {
        setCopiedKind(kind)
        setCopyFailed(!await copy(kind === 'url' ? monitorWebhookUrl(origin, props.token) : curl))
    }
    return <section className="rounded-[22px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4" data-testid="monitor-token-reveal">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Webhook · POST</h2>
            <div className="flex gap-2">
                {(['url', 'curl'] as const).map(kind => <button key={kind} type="button" onClick={() => void copyValue(kind)} aria-label={props.t('monitors.copy.' + kind)} title={props.t('monitors.copy.' + kind)} className="flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--app-border)] text-[var(--app-link)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
                    {copied && copiedKind === kind ? <Check className="h-4 w-4" /> : kind === 'url' ? <Link className="h-4 w-4" /> : <Terminal className="h-4 w-4" />}
                </button>)}
            </div>
        </div>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-[var(--app-code-bg)] p-3 text-xs leading-6"><code>{curl.replace(props.token, '••••••••')}</code></pre>
        {copyFailed ? <p role="alert" className="mt-2 text-sm text-red-600">{props.t('monitors.copy.failed')}</p> : null}
        <span className="sr-only" aria-live="polite">{copied ? props.t('monitors.token.copied') : ''}</span>
    </section>
}
