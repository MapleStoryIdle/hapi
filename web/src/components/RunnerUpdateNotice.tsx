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
        return <div className="mt-3 rounded-2xl border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-700 dark:text-green-300">Runner 已是最新版本 {release.version}</div>
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
        <div className="mt-3 rounded-2xl border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-xs text-orange-800 dark:text-orange-200">
            <div className="font-semibold">发现 Runner 新版本 {release.version}</div>
            <div className="mt-1">请在这台 Runner 电脑上人工执行：</div>
            <code className="mt-2 block overflow-x-auto rounded-lg bg-black/80 px-2 py-1.5 text-[11px] text-white">{command}</code>
            <button type="button" onClick={() => void copy()} className="mt-2 rounded-full border border-orange-500/30 px-2.5 py-1 font-medium hover:bg-orange-500/10">
                {copied ? '已复制' : '复制命令'}
            </button>
        </div>
    )
}
