import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { useTranslation } from '@/lib/use-translation'
import type { SessionType } from './types'

function FolderIcon(props: { className?: string }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

export function DirectorySection(props: {
    directory: string
    suggestions: readonly Suggestion[]
    selectedIndex: number
    isDisabled: boolean
    recentPaths: string[]
    sessionType: SessionType
    worktreeName: string
    worktreeInputRef: RefObject<HTMLInputElement | null>
    statusMessage?: string | null
    statusTone?: 'warning' | 'error' | null
    onDirectoryChange: (value: string) => void
    onDirectoryFocus: () => void
    onDirectoryBlur: () => void
    onDirectoryKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void
    onSuggestionSelect: (index: number) => void
    onPathClick: (path: string) => void
    onSessionTypeChange: (value: SessionType) => void
    onWorktreeNameChange: (value: string) => void
    onChooseFolder?: () => void
}) {
    const { t } = useTranslation()

    return (
        <div className="flex flex-col gap-4 rounded-[24px] border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]">
            <div>
                <label className="text-xs font-medium text-[var(--app-hint)]">
                    {t('newSession.directory')}
                </label>
            </div>
            <div className="flex items-start gap-2">
                <div className="relative flex-1 min-w-0">
                    <input
                        type="text"
                        placeholder={t('newSession.placeholder')}
                        value={props.directory}
                        onChange={(event) => props.onDirectoryChange(event.target.value)}
                        onKeyDown={props.onDirectoryKeyDown}
                        onFocus={props.onDirectoryFocus}
                        onBlur={props.onDirectoryBlur}
                        disabled={props.isDisabled}
                        className="ios-form-control h-11 w-full px-3 text-sm"
                    />
                    {props.suggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 z-10 mt-1">
                            <FloatingOverlay maxHeight={200}>
                                <Autocomplete
                                    suggestions={props.suggestions}
                                    selectedIndex={props.selectedIndex}
                                    onSelect={props.onSuggestionSelect}
                                />
                            </FloatingOverlay>
                        </div>
                    )}
                </div>
                {props.onChooseFolder && (
                    <button
                        type="button"
                        onClick={props.onChooseFolder}
                        disabled={props.isDisabled}
                        className="flex h-11 shrink-0 items-center gap-1.5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 text-xs font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                        title={t('newSession.browse')}
                    >
                        <FolderIcon className="h-3.5 w-3.5" />
                        {t('newSession.browse')}
                    </button>
                )}
            </div>
            {props.directory.trim() ? (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--app-border)] pt-3">
                    <span className="text-xs font-medium text-[var(--app-hint)]">
                        {t('newSession.type')}
                    </span>
                    <div
                        role="radiogroup"
                        aria-label={t('newSession.type')}
                        className="inline-flex shrink-0 items-center rounded-full border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-0.5"
                    >
                        {(['simple', 'worktree'] as const).map((type) => {
                            const checked = props.sessionType === type
                            return (
                                <label
                                    key={type}
                                    className={[
                                        'inline-flex h-7 cursor-pointer items-center rounded-full px-3 text-xs font-medium transition-colors',
                                        checked
                                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]',
                                        props.isDisabled ? 'cursor-not-allowed opacity-50' : ''
                                    ].filter(Boolean).join(' ')}
                                    title={type === 'simple'
                                        ? t('newSession.type.simple.desc')
                                        : t('newSession.type.worktree.desc')}
                                >
                                    <input
                                        type="radio"
                                        name="sessionType"
                                        value={type}
                                        checked={checked}
                                        onChange={() => props.onSessionTypeChange(type)}
                                        disabled={props.isDisabled}
                                        className="sr-only"
                                    />
                                    {type === 'simple'
                                        ? t('newSession.type.simple')
                                        : t('newSession.type.worktree')}
                                </label>
                            )
                        })}
                    </div>
                </div>
            ) : null}
            {props.directory.trim() && props.sessionType === 'worktree' ? (
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-[var(--app-hint)]">
                        {t('newSession.type.worktree')}
                    </label>
                    <input
                        ref={props.worktreeInputRef}
                        type="text"
                        placeholder={t('newSession.type.worktree.placeholder')}
                        value={props.worktreeName}
                        onChange={(event) => props.onWorktreeNameChange(event.target.value)}
                        disabled={props.isDisabled}
                        className="ios-form-control h-10 w-full px-3 text-sm"
                    />
                </div>
            ) : null}

            {!props.directory.trim() && props.recentPaths.length > 0 && (
                <div className="flex flex-col gap-1">
                    <span className="text-xs text-[var(--app-hint)]">{t('newSession.recent')}:</span>
                    <div className="flex flex-wrap gap-1">
                        {props.recentPaths.map((path) => (
                            <button
                                key={path}
                                type="button"
                                onClick={() => props.onPathClick(path)}
                                disabled={props.isDisabled}
                                className="max-w-full truncate rounded-xl bg-[var(--app-subtle-bg)] px-2 py-1 text-left text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:opacity-50 sm:max-w-[22rem]"
                                title={path}
                            >
                                <span className="block truncate" dir="rtl">
                                    <span dir="ltr">{path}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {props.statusMessage ? (
                <div
                    className={`rounded-xl px-2 py-1.5 text-xs ${
                        props.statusTone === 'error'
                            ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                            : 'bg-amber-500/10 text-[var(--app-hint)]'
                    }`}
                >
                    {props.statusMessage}
                </div>
            ) : null}
        </div>
    )
}
