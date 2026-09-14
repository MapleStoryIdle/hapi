import { useState } from 'react'
import { useRunnerRelease } from '@/hooks/queries/useRunnerRelease'
import { compareRunnerVersion } from '@/lib/runnerRelease'

export function RunnerUpdateNotice(props: { currentVersion?: string | null }) {
    const release = useRunnerRelease()
    const [copied, setCopied] = useState(false)
    if (!release) return null

    const status = compareRunnerVersion(props.currentVersion, release.version)
    if (status === 'unknown') return null
    if (status === 'current') {
        return <div className="mt-3 rounded-xl bg-green-500/10 px-3 py-2 text-xs font-medium text-green-700 dark:text-green-300">Runner {release.version} 已是最新版本</div>
    }
    if (status === 'ahead') {
        return <div className="mt-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">Runner {props.currentVersion} 比当前发布版本 {release.version} 更新。</div>
    }

    const origin = typeof window === 'undefined' ? '' : window.location.origin
    const command = origin === 'https://hapi.ye2moe.fun'
        ? `curl -fsSL ${origin}/install.sh | sh`
        : `curl -fsSL ${origin}/install.sh | sh -s -- --base-url ${origin}`
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(command)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
        } catch {
            setCopied(false)
        }
    }

    return (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-orange-500/30 bg-orange-500/10 px-3 py-2.5 text-xs text-orange-800 dark:text-orange-200">
            <div className="min-w-0 flex-1">
                <div className="font-semibold">Runner 可更新至 {release.version}</div>
                <div className="mt-0.5 text-[11px] opacity-80">复制后在 Runner 电脑执行</div>
            </div>
            <button type="button" onClick={() => void copy()} className="min-h-9 shrink-0 rounded-full border border-orange-500/30 px-3 font-medium hover:bg-orange-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
                {copied ? '已复制' : '复制更新命令'}
            </button>
        </div>
    )
}
