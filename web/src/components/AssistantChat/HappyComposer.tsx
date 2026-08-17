import { getCodexCollaborationModeOptions, getPermissionModeOptionsForFlavor } from '@hapi/protocol'
import { ComposerPrimitive, useAssistantApi, useAssistantState } from '@assistant-ui/react'
import {
    type ChangeEvent as ReactChangeEvent,
    type ClipboardEvent as ReactClipboardEvent,
    type FocusEvent as ReactFocusEvent,
    type FormEvent as ReactFormEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    type SyntheticEvent as ReactSyntheticEvent,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react'
import { GitBranch, Puzzle } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { AgentState, CodexCollaborationMode, PermissionMode, PiModelSummary, Session, SkillSummary, ThreadGoal } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ConversationStatus } from '@/realtime/types'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { findActiveWord } from '@/utils/findActiveWord'
import { applySuggestion } from '@/utils/applySuggestion'
import { usePlatform } from '@/hooks/usePlatform'
import { supportsEffort, supportsModelChange, PI_THINKING_LEVEL_LABELS } from '@hapi/protocol'
import type { PiThinkingLevel } from '@hapi/protocol'
import { markSkillUsed } from '@/lib/recent-skills'
import { useComposerDraft } from '@/hooks/useComposerDraft'
import { useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { Autocomplete } from '@/components/ChatInput/Autocomplete'
import { shouldShowComposerStatusBar, StatusBar } from '@/components/AssistantChat/StatusBar'
import { ComposerButtons, GoalModeIcon, PlanModeIcon, ToolbarMenu, UnifiedButton, getRemoteServerButtonAlias, type ContextUsageDetails } from '@/components/AssistantChat/ComposerButtons'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { AttachmentItem } from '@/components/AssistantChat/AttachmentItem'
import { ServerIcon, useRemoteServerContextSelection } from '@/components/RemoteServers'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { getModelOptionsForFlavor, getNextModelForFlavor } from './modelOptions'
import { getClaudeComposerEffortOptions } from './claudeEffortOptions'
import { getCodexComposerReasoningEffortOptions } from './codexReasoningEffortOptions'
import { getPiThinkingLevelOptions, getHighestThinkingLevel, isThinkingLevelSupported } from './piThinkingLevelOptions'
import { groupModelsByProvider } from './piModelGroups'
import { PiModelPanel } from './PiModelPanel'
import { PiThinkingLevelPanel } from './PiThinkingLevelPanel'

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

const LEADING_SKILL_TOKEN_PATTERN = /^\s*\$([A-Za-z0-9][A-Za-z0-9._:-]*)(?:\s+|$)/

function removeActiveSkillWord(
    text: string,
    selection: TextInputState['selection'],
    prefixes: string[]
): { text: string; cursorPosition: number } | null {
    const activeWord = findActiveWord(text, selection, prefixes)
    if (!activeWord?.activeWord.startsWith('$')) return null

    const before = text.slice(0, activeWord.offset)
    const after = text.slice(activeWord.endOffset)
    const normalizedAfter = before.endsWith(' ') && after.startsWith(' ')
        ? after.slice(1)
        : before.length === 0 && after.startsWith(' ')
            ? after.slice(1)
            : after

    return {
        text: `${before}${normalizedAfter}`,
        cursorPosition: before.length
    }
}

function removeLeadingKnownSkillToken(
    text: string,
    skillsByName: ReadonlyMap<string, SkillSummary>
): { text: string; cursorPosition: number } | null {
    const match = text.match(LEADING_SKILL_TOKEN_PATTERN)
    const name = match?.[1]
    if (!match || !name || !skillsByName.has(name)) return null

    const nextText = text.slice(match[0].length)
    return {
        text: nextText,
        cursorPosition: 0
    }
}

export function getComposerTextWithSelectedSkill(text: string, skillName?: string | null): string {
    const normalizedSkillName = skillName?.trim()
    if (!normalizedSkillName) return text

    const token = `$${normalizedSkillName}`
    const existing = text.match(LEADING_SKILL_TOKEN_PATTERN)
    if (existing?.[1] === normalizedSkillName) {
        return text
    }

    const body = text.trimStart()
    return body.length > 0 ? `${token} ${body}` : token
}

export function extractLeadingSkillForComposer(
    text: string,
    skillsByName: ReadonlyMap<string, SkillSummary>
): { skill: SkillSummary; text: string } | null {
    const match = text.match(LEADING_SKILL_TOKEN_PATTERN)
    const name = match?.[1]
    if (!match || !name) return null

    return {
        skill: skillsByName.get(name) ?? { name },
        text: text.slice(match[0].length)
    }
}

type ActiveSideSessionChip = {
    id: string
    title: string
}

function SideSessionChipIcon() {
    return <GitBranch strokeWidth={2} aria-hidden="true" />
}

/**
 * One rejected send.  `id` is bumped per failure so two failures with the
 * same `text` still trigger a fresh restore (the dedupe key is the id, not
 * the text).
 *
 * - `text` is the original input that should be put back into the composer.
 * - `message` is the user-facing error string we render inline.
 * - `scheduledAt` is the absolute epoch-ms the rejected send was bound for,
 *   or null for an immediate send.  When non-null, the composer also
 *   restores the schedule via `onSchedule` so the operator can edit and
 *   retry without silently downgrading a scheduled send to immediate.
 * - `action` is an optional recovery affordance rendered as a button next
 *   to the message.  Used by the inactive-session branch (#918) to expose
 *   a one-click Reopen.  Other failure modes (5xx, network, generic 4xx)
 *   leave this null and only render the message.
 *
 * Owned by the route component (`router.tsx`); the composer is a pure
 * consumer that:
 *  1. restores the text once per `id` via `api.composer().setText`,
 *  2. restores the schedule (if any) via `onSchedule`, and
 *  3. shows a red ring + inline message until the user types or sends.
 */
export type ComposerSendError = {
    id: number
    text: string
    message: string
    scheduledAt: number | null
    action?: {
        label: string
        onClick: () => void
        pending?: boolean
    } | null
}

const defaultSuggestionHandler = async (): Promise<Suggestion[]> => []
type SettingsPanel = 'main' | 'model' | 'speed'

function formatReasoningLabel(value: string | null | undefined, label: string, locale: 'en' | 'zh-CN'): string {
    const normalized = value?.trim().toLowerCase()
    if (locale !== 'zh-CN') return label
    if (!normalized || normalized === 'default') return '默认'
    if (normalized === 'low') return '低'
    if (normalized === 'medium') return '中'
    if (normalized === 'high') return '高'
    if (normalized === 'xhigh') return '超高'
    if (normalized === 'max') return '最高'
    if (normalized === 'ultra') return '极限'
    return label
}

function formatCompactModelLabel(label: string): string {
    return label
        .replace(/^GPT-/i, '')
        .replace(/^gpt-/i, '')
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

function formatDetailedTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) {
        const rounded = (value / 1_000).toFixed(1)
        return `${rounded.replace(/\.0$/, '')}K`
    }
    return String(value)
}

export function ModelEffortSettingsSection(props: {
    agentFlavor?: string | null
    options: Array<{ value: string; label: string }>
    selectedValue: string | null | undefined
    controlsDisabled: boolean
    onChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const { agentFlavor, options, selectedValue, controlsDisabled, onChange } = props

    return (
        <div className="py-2">
            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                {agentFlavor === 'cursor' ? t('misc.variant') : t('misc.effort')}
            </div>
            {options.map((option) => {
                const isSelected = selectedValue === option.value
                return (
                    <button
                        key={option.value}
                        type="button"
                        disabled={controlsDisabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            controlsDisabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => onChange(option.value)}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                isSelected
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {isSelected && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
                            {option.label}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

export function HappyComposer(props: {
    sessionId?: string
    disabled?: boolean
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    threadGoal?: ThreadGoal | null
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    active?: boolean
    allowSendWhenInactive?: boolean
    thinking?: boolean
    agentState?: AgentState | null
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    controlledByUser?: boolean
    agentFlavor?: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    /** Full Pi model data with thinkingLevelMap for provider grouping + thinking level filtering */
    piModels?: PiModelSummary[]
    /** Pi: provider-qualified selected model from metadata (survives reload;
     *  disambiguates when two providers share a modelId). */
    piSelectedModel?: { provider: string; modelId: string } | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    /** Cursor: selected base model key (not wire id). */
    selectedModelBase?: string | null
    /** Cursor: selected variant sku/wire for highlight when session stores an ACP wire id. */
    selectedModelVariant?: string | null
    /** Cursor: effort/variant wire ids for the selected base model. */
    modelEffortOptions?: Array<{ value: string; label: string }>
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelChange?: (model: { provider: string; modelId: string } | string | null) => void
    /** Cursor: effort/variant wire id (separate from base model change). */
    onModelEffortChange?: (wireId: string | null) => void
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => void
    onEffortChange?: (effort: string | null) => void
    /** Codex Fast mode (service tier): current value ('fast' or null/standard). */
    serviceTier?: string | null
    /** When provided, a Fast-mode toggle renders (Codex GPT-5.5 / GPT-5.4 only). */
    onServiceTierChange?: (serviceTier: string | null) => void
    onSwitchToRemote?: () => void
    onTerminal?: () => void
    terminalUnsupported?: boolean
    autocompletePrefixes?: string[]
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    skills?: SkillSummary[]
    skillsLoading?: boolean
    skillsError?: string | null
    // Voice assistant props
    voiceStatus?: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle?: () => void
    onVoiceMicToggle?: () => void
    // Schedule props (lifted from internal state when provided)
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    // Scratchlist drawer props - SessionChat owns the state. Threaded
    // straight through to ComposerButtons. When undefined, the toggle
    // button doesn't render (back-compat for any other consumer).
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    // Set when the most recent send failed (4xx/5xx/network).  The composer
    // restores the original text once per `sendError.id` and renders an
    // inline error affordance until the user dismisses or starts editing.
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    showStatusBar?: boolean
    remoteServerContext?: {
        api: ApiClient
        session: Session
        onChanged: () => void
    }
    activeSideSessions?: ActiveSideSessionChip[]
    onSelectSideSession?: (sessionId: string) => void
}) {
    const { t, locale } = useTranslation()
    const {
        sessionId,
        disabled = false,
        permissionMode: rawPermissionMode,
        collaborationMode: rawCollaborationMode,
        threadGoal,
        model: rawModel,
        modelReasoningEffort: rawModelReasoningEffort,
        effort: rawEffort,
        active = true,
        allowSendWhenInactive = false,
        thinking = false,
        agentState,
        backgroundTaskCount,
        contextSize,
        contextCacheRead,
        contextWindow,
        controlledByUser = false,
        agentFlavor,
        availableModelOptions,
        piModels,
        piSelectedModel,
        availableModelReasoningEffortOptions,
        selectedModelBase,
        selectedModelVariant,
        modelEffortOptions,
        onCollaborationModeChange,
        onPermissionModeChange,
        onModelChange,
        onModelEffortChange,
        onModelReasoningEffortChange,
        onEffortChange,
        serviceTier: rawServiceTier,
        onServiceTierChange,
        onSwitchToRemote,
        onTerminal,
        terminalUnsupported = false,
        autocompletePrefixes = ['@', '/', '$'],
        autocompleteSuggestions = defaultSuggestionHandler,
        skills = [],
        skillsLoading = false,
        skillsError = null,
        voiceStatus = 'disconnected',
        voiceMicMuted = false,
        onVoiceToggle,
        onVoiceMicToggle,
        pendingSchedule: pendingScheduleProp,
        onSchedule: onScheduleProp,
        onClearSchedule: onClearScheduleProp,
        sendError = null,
        onClearSendError,
        showStatusBar = true,
        remoteServerContext,
        activeSideSessions = [],
        onSelectSideSession
    } = props

    // Use ?? so missing values fall back to default (destructuring defaults only handle undefined)
    const permissionMode = rawPermissionMode ?? 'default'
    const collaborationMode = rawCollaborationMode ?? 'default'
    const model = rawModel ?? null
    const modelReasoningEffort = rawModelReasoningEffort ?? null
    const effort = rawEffort ?? null
    const serviceTier = rawServiceTier ?? null

    const queryClient = useQueryClient()
    const api = useAssistantApi()
    const { composerEnterBehavior } = useComposerEnterBehavior()
    const composerText = useAssistantState(({ composer }) => composer.text)
    const attachments = useAssistantState(({ composer }) => composer.attachments)
    const threadIsRunning = useAssistantState(({ thread }) => thread.isRunning)
    const threadIsDisabled = useAssistantState(({ thread }) => thread.isDisabled)
    const [selectedSkill, setSelectedSkill] = useState<SkillSummary | null>(null)

    const controlsDisabled = disabled || (!active && !allowSendWhenInactive) || threadIsDisabled
    const trimmed = composerText.trim()
    const hasText = trimmed.length > 0
    const hasAttachments = attachments.length > 0
    const attachmentsReady = !hasAttachments || attachments.every((attachment) => {
        if (attachment.status.type === 'complete') {
            return true
        }
        if (attachment.status.type !== 'requires-action') {
            return false
        }
        const path = (attachment as { path?: string }).path
        return typeof path === 'string' && path.length > 0
    })
    const canSend = (hasText || hasAttachments || selectedSkill !== null) && attachmentsReady && !controlsDisabled

    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 }
    })
    const [showSettings, setShowSettings] = useState(false)
    const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>('main')
    const [showPiModelPanel, setShowPiModelPanel] = useState(false)
    const [showPiThinkingPanel, setShowPiThinkingPanel] = useState(false)
    const [isAborting, setIsAborting] = useState(false)
    const [isSwitching, setIsSwitching] = useState(false)
    const [isClearingRemoteServer, setIsClearingRemoteServer] = useState(false)
    const [showSideSessionMenu, setShowSideSessionMenu] = useState(false)
    const [showContinueHint, setShowContinueHint] = useState(false)
    // Start small, expand while the text field is active, then return to the
    // compact entry point when focus leaves an empty composer. A typed draft
    // is always expanded, even after the textarea temporarily loses focus.
    const [composerExpanded, setComposerExpanded] = useState(false)
    // pendingSchedule is controlled externally when onSchedule prop is provided; otherwise local state
    const [pendingScheduleLocal, setPendingScheduleLocal] = useState<PendingSchedule | null>(null)
    const isControlled = onScheduleProp !== undefined
    const pendingSchedule = isControlled ? (pendingScheduleProp ?? null) : pendingScheduleLocal
    const setPendingSchedule = isControlled ? onScheduleProp : setPendingScheduleLocal

    useEffect(() => {
        if (activeSideSessions.length <= 1) {
            setShowSideSessionMenu(false)
        }
    }, [activeSideSessions.length])

    const composerRootRef = useRef<HTMLDivElement>(null)
    const composerBlurFrameRef = useRef<number | null>(null)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const settingsButtonRef = useRef<HTMLButtonElement>(null)
    const piModelButtonRef = useRef<HTMLButtonElement>(null)
    const sideSessionButtonRef = useRef<HTMLButtonElement>(null)
    const prevControlledByUser = useRef(controlledByUser)
    const skillsByName = useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills])
    const { selected: selectedRemoteServer } = useRemoteServerContextSelection(
        remoteServerContext?.api ?? null,
        remoteServerContext?.session ?? null
    )

    useComposerDraft(sessionId, composerText, (text) => api.composer().setText(text))

    // assistant-ui clears `composer.text` synchronously the moment a send is
    // invoked AND `SessionChat.handleSend` clears `pendingSchedule` the
    // moment the mutation is accepted, so by the time the mutation's
    // onError fires both the typed text and the schedule are gone.  When
    // the route hands us a `sendError`, splice both back in -- once per
    // `sendError.id` so a second failure with the same text still triggers
    // a fresh restore.
    const restoredErrorIdRef = useRef<number | null>(null)
    useEffect(() => {
        if (!sendError) {
            return
        }
        if (restoredErrorIdRef.current === sendError.id) {
            return
        }
        restoredErrorIdRef.current = sendError.id
        // Only restore when the composer is empty.  If the user has already
        // typed something new (rare -- composer is `disabled` during send,
        // but possible if isSending toggles before this effect runs), we
        // would otherwise stomp on their fresh input.
        if (composerText.length === 0 && sendError.text.length > 0) {
            const restored = extractLeadingSkillForComposer(sendError.text, skillsByName)
            if (restored) {
                setSelectedSkill(restored.skill)
                api.composer().setText(restored.text)
            } else {
                api.composer().setText(sendError.text)
            }
        }
        // Restore the pending schedule too.  `scheduledAt` was already
        // resolved to an absolute epoch-ms before the failed send (presets
        // are computed at send time -- see `resolvePendingSchedule`), so
        // we feed it back as an 'absolute' PendingSchedule.  The existing
        // shouldAutoClearPendingSchedule effect in SessionChat handles the
        // case where the absolute time has passed by the time we restore.
        if (sendError.scheduledAt !== null && onScheduleProp) {
            onScheduleProp({ type: 'absolute', ms: sendError.scheduledAt })
        }
    }, [sendError, api, composerText, onScheduleProp, skillsByName])

    useEffect(() => {
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            // When syncing from composerText, update selection to end of text
            // This ensures activeWord detection works correctly
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText])

    // Track one-time "continue" hint after switching from local to remote.
    useEffect(() => {
        if (prevControlledByUser.current === true && controlledByUser === false) {
            setShowContinueHint(true)
        }
        if (controlledByUser) {
            setShowContinueHint(false)
        }
        prevControlledByUser.current = controlledByUser
    }, [controlledByUser])

    const { haptic: platformHaptic } = usePlatform()
    // The composer is an overlay, not scrollable message content. Keep its
    // controls above the iOS home indicator, with a small visual breathing
    // room, while the thread itself remains edge-to-edge.
    const bottomPaddingClass = composerExpanded || hasText
        ? 'pb-[calc(var(--app-composer-expanded-bottom-gap)+var(--app-composer-safe-area-bottom)+var(--app-composer-expanded-keyboard-offset))]'
        : 'pb-[calc(1.25rem+var(--app-composer-safe-area-bottom))]'
    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true }
    )

    const haptic = useCallback((type: 'light' | 'success' | 'error' = 'light') => {
        if (type === 'light') {
            platformHaptic.impact('light')
        } else if (type === 'success') {
            platformHaptic.notification('success')
        } else {
            platformHaptic.notification('error')
        }
    }, [platformHaptic])

    const focusComposerInput = useCallback(() => {
        const el = textareaRef.current
        if (!el || controlsDisabled) return
        try {
            el.focus({ preventScroll: true })
        } catch {
            el.focus()
        }
    }, [controlsDisabled])

    const focusComposerInputAt = useCallback((cursorPosition: number) => {
        if (controlsDisabled) return

        const applySelection = () => {
            const el = textareaRef.current
            if (!el) return
            const resolvedPosition = Math.min(cursorPosition, el.value.length)
            el.setSelectionRange(resolvedPosition, resolvedPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }

        applySelection()
        window.setTimeout(applySelection, 0)
        window.requestAnimationFrame(() => {
            applySelection()
            window.requestAnimationFrame(applySelection)
        })
    }, [controlsDisabled])

    const handleComposerPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const target = event.target
        if (target instanceof Element && target.closest('button,a,input,select,[role="button"],[contenteditable="true"]')) {
            return
        }
        focusComposerInput()
    }, [focusComposerInput])

    const preserveComposerFocusForAction = useCallback((event: ReactMouseEvent<HTMLElement>) => {
        const target = event.target
        if (target instanceof Element && target.closest('button')) {
            // Keep the textarea focused while a composer action is tapped.
            // Do this at `mousedown`, not `pointerdown`: current iOS WebKit
            // can suppress the compatibility mouse/click sequence when a
            // pointerdown is cancelled, leaving the keyboard dismissed and
            // the action unhandled.
            event.preventDefault()
        }
    }, [])

    const handleSkillSelect = useCallback((skill: SkillSummary) => {
        if (controlsDisabled) return

        if (selectedSkill?.name === skill.name) {
            setSelectedSkill(null)
            clearSuggestions()
            focusComposerInput()
            haptic('light')
            return
        }

        const result = activeWord?.startsWith('$')
            ? removeActiveSkillWord(inputState.text, inputState.selection, autocompletePrefixes)
            : removeLeadingKnownSkillToken(inputState.text, skillsByName)

        markSkillUsed(skill.name)
        setSelectedSkill(skill)
        if (result) {
            api.composer().setText(result.text)
            setInputState({
                text: result.text,
                selection: { start: result.cursorPosition, end: result.cursorPosition }
            })
            focusComposerInputAt(result.cursorPosition)
        } else {
            focusComposerInput()
        }
        clearSuggestions()

        haptic('light')
    }, [
        activeWord,
        api,
        autocompletePrefixes,
        clearSuggestions,
        controlsDisabled,
        focusComposerInput,
        focusComposerInputAt,
        haptic,
        inputState,
        selectedSkill,
        skillsByName
    ])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion || !textareaRef.current) return

        if (suggestion.text.startsWith('$')) {
            const skillName = suggestion.text.slice(1)
            const skill = skillsByName.get(skillName)
            if (skill) {
                handleSkillSelect(skill)
                return
            }
            markSkillUsed(skillName)
        }

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            autocompletePrefixes,
            true
        )

        api.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition }
        })

        focusComposerInputAt(result.cursorPosition)

        haptic('light')
    }, [api, suggestions, inputState, autocompletePrefixes, focusComposerInputAt, haptic, skillsByName, handleSkillSelect])

    const abortDisabled = controlsDisabled || isAborting || !threadIsRunning
    const switchDisabled = controlsDisabled || isSwitching || !controlledByUser
    const showSwitchButton = Boolean(controlledByUser && onSwitchToRemote)
    const showTerminalButton = Boolean(onTerminal || terminalUnsupported)
    const terminalDisabled = controlsDisabled || terminalUnsupported
    const terminalLabel = terminalUnsupported ? t('terminal.unsupportedWindows') : t('composer.terminal')

    useEffect(() => {
        if (!isAborting) return
        if (threadIsRunning) return
        setIsAborting(false)
    }, [isAborting, threadIsRunning])

    useEffect(() => {
        if (!isSwitching) return
        if (controlledByUser) return
        setIsSwitching(false)
    }, [isSwitching, controlledByUser])

    const handleAbort = useCallback(() => {
        if (abortDisabled) return
        haptic('error')
        setIsAborting(true)
        api.thread().cancelRun()
    }, [abortDisabled, api, haptic])

    const handleSwitch = useCallback(async () => {
        if (switchDisabled || !onSwitchToRemote) return
        haptic('light')
        setIsSwitching(true)
        try {
            await onSwitchToRemote()
        } catch {
            setIsSwitching(false)
        }
    }, [switchDisabled, onSwitchToRemote, haptic])

    const handleClearRemoteServer = useCallback(async () => {
        if (!remoteServerContext || controlsDisabled || isClearingRemoteServer) return
        setIsClearingRemoteServer(true)
        try {
            await remoteServerContext.api.setSessionRemoteServer(remoteServerContext.session.id, null)
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: queryKeys.session(remoteServerContext.session.id) }),
                queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
            ])
            remoteServerContext.onChanged()
            haptic('light')
        } finally {
            setIsClearingRemoteServer(false)
        }
    }, [controlsDisabled, haptic, isClearingRemoteServer, queryClient, remoteServerContext])

    const sendComposerMessage = useCallback(() => {
        if (selectedSkill) {
            api.composer().setText(getComposerTextWithSelectedSkill(composerText, selectedSkill.name))
            setSelectedSkill(null)
        }
        api.composer().send()
        setShowContinueHint(false)
        // SessionChat owns clearing the schedule — it clears only after awaiting
        // the send hook's accepted result, which covers both pre-mutation guards
        // and async inactive-session resume failure. Clearing here unconditionally
        // would race ahead of that check and drop the user's schedule on every
        // rejected send path.
        //
        // The inline send-error affordance is intentionally NOT cleared here:
        // the route-level state (`onSuccess`/`onError` in router.tsx) replaces
        // or clears it based on the actual mutation result, so the user keeps
        // the error context while the new attempt is in flight.
    }, [api, composerText, selectedSkill])

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )
    const collaborationModeOptions = useMemo(
        () => agentFlavor === 'codex' ? getCodexCollaborationModeOptions() : [],
        [agentFlavor]
    )
    const modelOptions = useMemo(
        () => getModelOptionsForFlavor(agentFlavor, model, availableModelOptions),
        [agentFlavor, model, availableModelOptions]
    )
    const codexReasoningEffortOptions = useMemo(
        () => agentFlavor === 'codex' || agentFlavor === 'opencode'
            ? getCodexComposerReasoningEffortOptions(
                modelReasoningEffort,
                agentFlavor,
                availableModelReasoningEffortOptions
            )
            : [],
        [agentFlavor, modelReasoningEffort, availableModelReasoningEffortOptions]
    )
    // Pi: group models by provider for hierarchical display
    const piModelGroups = useMemo(
        () => piModels && piModels.length > 0 ? groupModelsByProvider(piModels) : null,
        [piModels]
    )
    // Pi: find the currently selected model's thinkingLevelMap for effort filtering.
    // Prefer provider-qualified match (metadata.piSelectedModel) when available —
    // two providers may share a modelId, and a modelId-only match would pick the
    // wrong one, sending the wrong provider on the next model/effort change.
    const selectedPiModel = useMemo(
        () => piSelectedModel
            ? piModels?.find((m) => m.provider === piSelectedModel.provider && m.modelId === piSelectedModel.modelId)
            : piModels?.find((m) => m.modelId === model),
        [piModels, piSelectedModel, model]
    )

    // Pi: reset effort to highest supported level when model changes and current level is unsupported
    useEffect(() => {
        if (!effort || !selectedPiModel || !onEffortChange) return
        // Non-reasoning model: clear stale effort so the hub does not forward
        // a set_thinking_level the user can no longer see or change.
        if (selectedPiModel.reasoning === false) {
            onEffortChange(null)
            return
        }
        if (!isThinkingLevelSupported(effort, selectedPiModel.thinkingLevelMap)) {
            onEffortChange(getHighestThinkingLevel(selectedPiModel.thinkingLevelMap))
        }
    }, [selectedPiModel, effort, onEffortChange])
    const claudeEffortOptions = useMemo(
        () => agentFlavor === 'pi'
            ? getPiThinkingLevelOptions(effort, selectedPiModel?.thinkingLevelMap)
            : getClaudeComposerEffortOptions(effort),
        [agentFlavor, effort, selectedPiModel]
    )
    const permissionModes = useMemo(
        () => permissionModeOptions.map((option) => option.mode),
        [permissionModeOptions]
    )

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        const key = e.key

        // Avoid intercepting IME composition keystrokes (Enter, arrows, etc.)
        if (e.nativeEvent.isComposing) {
            return
        }

        // Shift+Enter inserts a newline (standard behavior)
        if (key === 'Enter' && e.shiftKey) {
            return // let default textarea behavior handle newline
        }

        // Enter with suggestions visible: select the suggestion
        if (key === 'Enter' && suggestions.length > 0) {
            e.preventDefault()
            const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
            handleSuggestionSelect(indexToSelect)
            return
        }

        // Only plain Enter (no modifiers) sends; other modifier combos are ignored
        if (key === 'Enter') {
            if (composerEnterBehavior === 'newline') {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && canSend) {
                    e.preventDefault()
                    sendComposerMessage()
                }
                return
            }
            e.preventDefault()
            if (!e.ctrlKey && !e.altKey && !e.metaKey && canSend) {
                sendComposerMessage()
            }
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if ((key === 'Tab') && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
            if (key === 'Escape') {
                e.preventDefault()
                clearSuggestions()
                return
            }
        }

        if (key === 'Escape' && threadIsRunning) {
            e.preventDefault()
            handleAbort()
            return
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 0) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'default'
            onPermissionModeChange(nextMode)
            haptic('light')
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        canSend,
        haptic,
        composerEnterBehavior,
        sendComposerMessage
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            // Pi needs { provider, modelId } to disambiguate duplicate model IDs,
            // but this generic cycler only emits a bare modelId (or null), which
            // would lose the provider and can pick the wrong cached match or clear
            // the model. Pi model changes go only through the dedicated PiModelPanel.
            if (agentFlavor === 'pi') return
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && onModelChange && supportsModelChange(agentFlavor)) {
                e.preventDefault()
                onModelChange(getNextModelForFlavor(agentFlavor, model, availableModelOptions))
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [model, onModelChange, haptic, agentFlavor, availableModelOptions])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd
        }
        setInputState({ text: e.target.value, selection })
        // Editing the restored text is the operator's "I'm handling it"
        // signal -- drop the inline error so the affordance doesn't shout
        // at them while they fix the message.
        if (sendError && onClearSendError) {
            onClearSendError()
        }
    }, [sendError, onClearSendError])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState(prev => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd }
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
        const files = Array.from(e.clipboardData?.files || [])
        const imageFiles = files.filter(file => file.type.startsWith('image/'))

        if (imageFiles.length === 0) return

        // The backend rejects scheduledAt + attachments (per-CLI upload dir is
        // torn down before a mature emit could read the files). The button-based
        // attachment flow is disabled by ComposerButtons.hasAttachments, but the
        // paste path bypasses that — guard here so a pasted image while a
        // schedule is active cannot produce a submission the hub will reject.
        if (pendingSchedule != null) {
            e.preventDefault()
            return
        }

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api, pendingSchedule])

    const handleSettingsToggle = useCallback(() => {
        haptic('light')
        setShowSettings(prev => {
            const next = !prev
            if (next) {
                setSettingsPanel('main')
            }
            return next
        })
    }, [haptic])

    const handleSubmit = useCallback((event?: ReactFormEvent<HTMLFormElement>) => {
        event?.preventDefault()
        if (!attachmentsReady) {
            return
        }
        setShowContinueHint(false)
    }, [attachmentsReady])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic])

    const handleCollaborationChange = useCallback((mode: CodexCollaborationMode) => {
        if (!onCollaborationModeChange || controlsDisabled) return
        onCollaborationModeChange(mode)
        setShowSettings(false)
        haptic('light')
    }, [onCollaborationModeChange, controlsDisabled, haptic])

    const handlePlanModeToggle = useCallback(() => {
        handleCollaborationChange(collaborationMode === 'plan' ? 'default' : 'plan')
    }, [collaborationMode, handleCollaborationChange])

    const handleGoalModeOpen = useCallback(() => {
        if (controlsDisabled) return
        const trimmedStart = composerText.trimStart()
        const nextText = trimmedStart.startsWith('/goal')
            ? composerText
            : composerText.trim().length > 0
                ? `/goal ${composerText.trim()}`
                : '/goal '
        api.composer().setText(nextText)
        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            const cursor = nextText.length
            el.setSelectionRange(cursor, cursor)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)
        haptic('light')
    }, [api, composerText, controlsDisabled, haptic])

    const handleSideSessionChipClick = useCallback(() => {
        if (!onSelectSideSession || activeSideSessions.length === 0) return
        haptic('light')
        const first = activeSideSessions[0]
        if (activeSideSessions.length === 1 && first) {
            onSelectSideSession(first.id)
            return
        }
        setShowSideSessionMenu((open) => !open)
    }, [activeSideSessions, haptic, onSelectSideSession])

    const handleSideSessionSelect = useCallback((sessionId: string) => {
        setShowSideSessionMenu(false)
        onSelectSideSession?.(sessionId)
    }, [onSelectSideSession])

    const handleModelChange = useCallback((nextModel: { provider: string; modelId: string } | string | null) => {
        if (!onModelChange || controlsDisabled) return
        onModelChange(nextModel)
        setShowSettings(false)
        haptic('light')
    }, [onModelChange, controlsDisabled, haptic])

    const handleModelEffortChange = useCallback((nextWireId: string | null) => {
        const handler = onModelEffortChange ?? onModelChange
        if (!handler || controlsDisabled) return
        handler(nextWireId)
        setShowSettings(false)
        haptic('light')
    }, [onModelEffortChange, onModelChange, controlsDisabled, haptic])

    const handleModelReasoningEffortChange = useCallback((nextModelReasoningEffort: string | null) => {
        if (!onModelReasoningEffortChange || controlsDisabled) return
        onModelReasoningEffortChange(nextModelReasoningEffort)
        setShowSettings(false)
        haptic('light')
    }, [onModelReasoningEffortChange, controlsDisabled, haptic])

    const handleEffortChange = useCallback((nextEffort: string | null) => {
        if (!onEffortChange || controlsDisabled) return
        onEffortChange(nextEffort)
        setShowSettings(false)
        haptic('light')
    }, [onEffortChange, controlsDisabled, haptic])

    const handleServiceTierChange = useCallback((nextServiceTier: string | null) => {
        if (!onServiceTierChange || controlsDisabled) return
        onServiceTierChange(nextServiceTier)
        setShowSettings(false)
        haptic('light')
    }, [onServiceTierChange, controlsDisabled, haptic])

    // 'standard' (not null) is the explicit Fast-off choice so it persists
    // distinctly from an untouched/account-default session.
    const fastModeOptions: Array<{ value: string; label: string }> = useMemo(() => [
        { value: 'standard', label: t('misc.fastModeStandard') },
        { value: 'fast', label: t('misc.fastModeFast') }
    ], [t])

    const showCollaborationSettings = Boolean(onCollaborationModeChange && collaborationModeOptions.length > 0)
    const showPlanModeTool = Boolean(
        agentFlavor === 'codex'
        && onCollaborationModeChange
        && collaborationModeOptions.some((option) => option.mode === 'plan')
    )
    const showGoalModeTool = agentFlavor === 'codex'
    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showModelSettings = Boolean(onModelChange && supportsModelChange(agentFlavor) && (piModels && piModels.length > 0 || modelOptions.length > 0))
    const showModelEffortSettings = Boolean(
        (onModelEffortChange ?? onModelChange)
        && modelEffortOptions
        && modelEffortOptions.length > 0
    )
    const showModelReasoningEffortSettings = Boolean(onModelReasoningEffortChange && codexReasoningEffortOptions.length > 0)
    // For Pi: hide effort when selected model explicitly has reasoning: false
    const piEffortHidden = piModels && selectedPiModel && selectedPiModel.reasoning === false
    const showEffortSettings = Boolean(onEffortChange && supportsEffort(agentFlavor) && !piEffortHidden)
    const showFastModeSettings = Boolean(onServiceTierChange)
    const showSettingsButton = Boolean(
        showCollaborationSettings
        || showModelSettings
        || showModelEffortSettings
        || showModelReasoningEffortSettings
        || showEffortSettings
        || showFastModeSettings
    )
    const showAbortButton = true
    const voiceEnabled = Boolean(onVoiceToggle)
    const compactRoutesToScratchlist = Boolean(
        props.scratchlistMode
        && !hasAttachments
        && pendingSchedule === null
    )
    const showPlanSelectionChip = Boolean(showPlanModeTool && collaborationMode === 'plan')
    const showGoalSelectionChip = Boolean(showGoalModeTool && threadGoal?.status === 'active')
    const showSideSessionChip = Boolean(onSelectSideSession && activeSideSessions.length > 0)
    const firstActiveSideSession = activeSideSessions[0] ?? null
    const remoteServerAlias = selectedRemoteServer ? getRemoteServerButtonAlias(selectedRemoteServer) : null
    const hasSelectionChips = selectedSkill !== null
        || showPlanSelectionChip
        || showGoalSelectionChip
        || showSideSessionChip
        || selectedRemoteServer !== null
    const requiresExpandedComposer = hasText
        || hasAttachments
        || pendingSchedule !== null
        || sendError !== null
        || hasSelectionChips

    // Derive the visual state from the draft too, rather than waiting for the
    // effect below. This prevents one compact render between the first typed
    // character and the persistent expanded state.
    const composerCompact = !composerExpanded && !requiresExpandedComposer

    useEffect(() => {
        if (requiresExpandedComposer) {
            setComposerExpanded(true)
        }
    }, [requiresExpandedComposer])

    const handleComposerFocus = useCallback(() => {
        if (composerCompact) {
            setComposerExpanded(true)
        }
    }, [composerCompact])
    const handleComposerBlur = useCallback((_event: ReactFocusEvent<HTMLTextAreaElement>) => {
        if (composerBlurFrameRef.current !== null) {
            window.cancelAnimationFrame(composerBlurFrameRef.current)
        }
        // Let a click on a toolbar control settle first. Collapsing during the
        // input's blur phase would unmount that control before its click fires.
        composerBlurFrameRef.current = window.requestAnimationFrame(() => {
            composerBlurFrameRef.current = null
            if (requiresExpandedComposer) {
                return
            }
            const activeElement = document.activeElement
            if (activeElement instanceof Node && composerRootRef.current?.contains(activeElement)) {
                return
            }
            setComposerExpanded(false)
        })
    }, [requiresExpandedComposer])
    useEffect(() => {
        return () => {
            if (composerBlurFrameRef.current !== null) {
                window.cancelAnimationFrame(composerBlurFrameRef.current)
            }
        }
    }, [])
    // Keep one surface mounted and morph its grid tracks instead of swapping
    // a pill for a panel. This is the web equivalent of a container transform:
    // the input remains the visual anchor while the toolbar fades in after the
    // surface starts opening.
    const composerGridRowsClass = composerCompact
        ? 'grid-rows-[0fr_48px_0fr]'
        : hasAttachments
            ? 'grid-rows-[auto_auto_1fr]'
            : 'grid-rows-[0fr_auto_1fr]'

    const currentModelLabel = useMemo(() => {
        if (selectedModelBase !== undefined) {
            const match = modelOptions.find((option) => option.value === selectedModelBase)
            if (match) return match.label
        }
        const match = modelOptions.find((option) => option.value === model)
        return match?.label ?? model ?? t('misc.model')
    }, [model, modelOptions, selectedModelBase, t])
    const currentReasoningOption = useMemo(
        () => codexReasoningEffortOptions.find((option) => option.value === modelReasoningEffort)
            ?? codexReasoningEffortOptions.find((option) => option.value === null)
            ?? null,
        [codexReasoningEffortOptions, modelReasoningEffort]
    )
    const currentReasoningLabel = currentReasoningOption
        ? formatReasoningLabel(currentReasoningOption.value, currentReasoningOption.label, locale)
        : null
    const compactModelLabel = formatCompactModelLabel(currentModelLabel)
    const settingsLabel = currentReasoningLabel
        ? `${compactModelLabel} ${currentReasoningLabel}`
        : compactModelLabel
    const permissionLabel = useMemo(
        () => permissionModeOptions.find((option) => option.mode === permissionMode)?.label ?? permissionMode,
        [permissionModeOptions, permissionMode]
    )
    const contextUsage = useMemo(() => {
        if (contextSize === undefined) return null
        const maxContextSize = contextWindow ?? getContextBudgetTokens(model, agentFlavor)
        if (!maxContextSize) {
            return {
                percentage: 0,
                label: `ctx ${formatTokenCount(contextSize)}`
            }
        }

        const percentage = Math.min(100, Math.max(0, (contextSize / maxContextSize) * 100))
        const percentageLeft = Math.max(0, Math.round(100 - percentage))
        return {
            percentage,
            label: `ctx ${formatTokenCount(contextSize)}/${formatTokenCount(maxContextSize)} (${percentageLeft}% left)`
        }
    }, [contextSize, contextWindow, model, agentFlavor])
    const contextUsageDetails = useMemo<ContextUsageDetails | null>(() => {
        if (contextSize === undefined) return null
        const maxContextSize = contextWindow ?? getContextBudgetTokens(model, agentFlavor)
        const remainingTokens = maxContextSize
            ? Math.max(0, maxContextSize - contextSize)
            : null
        const remainingPercent = maxContextSize
            ? Math.max(0, Math.min(100, (remainingTokens ?? 0) / maxContextSize * 100))
            : null

        return {
            usedTokens: contextSize,
            windowTokens: maxContextSize,
            cacheReadTokens: contextCacheRead,
            source: contextWindow
                ? 'model'
                : maxContextSize
                    ? 'estimated'
                    : 'unknown',
            usedLabel: formatDetailedTokenCount(contextSize),
            remainingLabel: remainingTokens === null ? null : formatDetailedTokenCount(remainingTokens),
            windowLabel: maxContextSize === null ? null : formatDetailedTokenCount(maxContextSize),
            cacheReadLabel: contextCacheRead && contextCacheRead > 0
                ? formatDetailedTokenCount(contextCacheRead)
                : null,
            remainingPercent
        }
    }, [agentFlavor, contextCacheRead, contextSize, contextWindow, model])

    // Pi: selected model info for UI labels and thinking level filtering
    const piModelLabel = agentFlavor === 'pi'
        ? (selectedPiModel?.name ?? selectedPiModel?.modelId ?? 'Model')
        : undefined
    const piThinkingLabel = agentFlavor === 'pi'
        ? (() => {
            if (!selectedPiModel) return 'Thinking'
            const effectiveLevel = effort && isThinkingLevelSupported(effort, selectedPiModel.thinkingLevelMap)
                ? effort
                : getHighestThinkingLevel(selectedPiModel.thinkingLevelMap)
            return effectiveLevel
                ? (PI_THINKING_LEVEL_LABELS[effectiveLevel as PiThinkingLevel] ?? effectiveLevel)
                : 'Thinking'
        })()
        : undefined
    const piHasModels = piModels && piModels.length > 0

    const closeAllPanels = useCallback(() => {
        setShowSettings(false)
        setShowPiModelPanel(false)
        setShowPiThinkingPanel(false)
    }, [])

    const handlePiModelToggle = useCallback(() => {
        if (controlsDisabled) return
        setShowPiModelPanel((v) => !v)
        setShowSettings(false)
        setShowPiThinkingPanel(false)
        haptic('light')
    }, [controlsDisabled, haptic])

    const handlePiThinkingToggle = useCallback(() => {
        if (controlsDisabled) return
        setShowPiThinkingPanel((v) => !v)
        setShowSettings(false)
        setShowPiModelPanel(false)
        haptic('light')
    }, [controlsDisabled, haptic])

    useEffect(() => {
        if (!showSettings) return

        function handlePointerDown(event: PointerEvent) {
            const target = event.target
            if (!(target instanceof Element)) return
            if (target.closest('[data-composer-settings-menu], .settings-button')) return
            setShowSettings(false)
        }

        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [showSettings])

    const overlays = useMemo(() => {
        // Pi flavor: separate floating panels for model and thinking level.
        // (Pi RPC mode has no runtime permission switching → no permission panel.)
        if (agentFlavor === 'pi') {
            const panels: React.ReactNode[] = []

            // Model selection panel
            if (showPiModelPanel && piModels && piModels.length > 0) {
                const currentPiModel = selectedPiModel ?? null
                panels.push(
                    <ToolbarMenu
                        key="model"
                        anchorRef={piModelButtonRef}
                        align="right"
                        width={256}
                        maxHeight={360}
                        onClose={closeAllPanels}
                    >
                        <PiModelPanel
                            models={piModels}
                            currentModel={currentPiModel ? { provider: currentPiModel.provider, modelId: currentPiModel.modelId } : null}
                            controlsDisabled={controlsDisabled}
                            onSelect={(piModel) => {
                                handleModelChange({ provider: piModel.provider, modelId: piModel.modelId })
                            }}
                            onClose={closeAllPanels}
                            embedded
                        />
                    </ToolbarMenu>
                )
            }

            // Thinking level panel
            if (showPiThinkingPanel && selectedPiModel?.reasoning !== false) {
                panels.push(
                    <ToolbarMenu
                        key="thinking"
                        anchorRef={piModelButtonRef}
                        align="right"
                        width={192}
                        maxHeight={240}
                        onClose={closeAllPanels}
                    >
                        <PiThinkingLevelPanel
                            currentLevel={effort}
                            reasoning={selectedPiModel?.reasoning}
                            thinkingLevelMap={selectedPiModel?.thinkingLevelMap}
                            controlsDisabled={controlsDisabled}
                            onSelect={(level) => handleEffortChange(level)}
                            onClose={closeAllPanels}
                            embedded
                        />
                    </ToolbarMenu>
                )
            }

            if (panels.length > 0) return <>{panels}</>
        }

        const renderMenuOption = (
            key: string,
            selected: boolean,
            label: string,
            onClick: () => void
        ) => (
            <button
                key={key}
                type="button"
                disabled={controlsDisabled}
                className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors ${
                    controlsDisabled
                        ? 'cursor-not-allowed opacity-50'
                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                }`}
                onClick={onClick}
                onMouseDown={(e) => e.preventDefault()}
            >
                <span className={selected ? 'font-medium text-[var(--app-fg)]' : 'text-[var(--app-fg)]'}>
                    {label}
                </span>
                {selected ? <span className="text-[var(--app-hint)]">✓</span> : <span className="h-4 w-4" />}
            </button>
        )
        const renderMenuRow = (key: string, label: string, onClick: () => void) => (
            <button
                key={key}
                type="button"
                disabled={controlsDisabled}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={onClick}
                onMouseDown={(e) => e.preventDefault()}
            >
                <span className="truncate">{label}</span>
                <span className="text-base leading-none text-[var(--app-hint)]">›</span>
            </button>
        )
        const renderBackRow = (label: string) => (
            <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                onClick={() => setSettingsPanel('main')}
                onMouseDown={(e) => e.preventDefault()}
            >
                <span className="text-base leading-none">‹</span>
                {label}
            </button>
        )
        const sectionDivider = <div className="mx-3 h-px bg-[var(--app-divider)]" />

        // Non-Pi flavors: compact lower-right menu, with model/speed as subpanels.
        if (showSettings && (showCollaborationSettings || showModelSettings || showModelEffortSettings || showModelReasoningEffortSettings || showEffortSettings || showFastModeSettings)) {
            if (settingsPanel === 'model') {
                return (
                    <div data-composer-settings-menu>
                        <ToolbarMenu
                            anchorRef={settingsButtonRef}
                            align="right"
                            width={210}
                            maxHeight={320}
                            onClose={() => setShowSettings(false)}
                        >
                            {renderBackRow(t('misc.model'))}
                            {sectionDivider}
                            {showModelSettings ? (
                                piModelGroups ? (
                                    piModelGroups.map((group) => (
                                        <div key={group.provider}>
                                            <div className="px-3 pt-2 pb-0.5 text-xs font-medium text-[var(--app-hint)]">
                                                {group.label}
                                            </div>
                                            {group.models.map((piModel) => renderMenuOption(
                                                piModel.modelId,
                                                model === piModel.modelId,
                                                piModel.name ?? piModel.modelId,
                                                () => handleModelChange({ provider: piModel.provider, modelId: piModel.modelId })
                                            ))}
                                        </div>
                                    ))
                                ) : (
                                    modelOptions.map((option) => {
                                        const isSelected = selectedModelBase !== undefined
                                            ? selectedModelBase === option.value
                                            : model === option.value
                                        return renderMenuOption(
                                            option.value ?? 'auto',
                                            isSelected,
                                            option.label,
                                            () => handleModelChange(option.value)
                                        )
                                    })
                                )
                            ) : null}
                            {showModelSettings && showModelEffortSettings ? sectionDivider : null}
                            {showModelEffortSettings ? (
                                modelEffortOptions!.map((option) => renderMenuOption(
                                    option.value ?? 'auto',
                                    (selectedModelVariant ?? model) === option.value,
                                    option.label,
                                    () => handleModelEffortChange(option.value)
                                ))
                            ) : null}
                        </ToolbarMenu>
                    </div>
                )
            }

            if (settingsPanel === 'speed') {
                return (
                    <div data-composer-settings-menu>
                        <ToolbarMenu
                            anchorRef={settingsButtonRef}
                            align="right"
                            width={210}
                            maxHeight={240}
                            onClose={() => setShowSettings(false)}
                        >
                            {renderBackRow(t('misc.speed'))}
                            {sectionDivider}
                            {fastModeOptions.map((option) => renderMenuOption(
                                option.value ?? 'standard',
                                serviceTier === option.value,
                                option.label,
                                () => handleServiceTierChange(option.value)
                            ))}
                        </ToolbarMenu>
                    </div>
                )
            }

            return (
                <div data-composer-settings-menu>
                    <ToolbarMenu
                        anchorRef={settingsButtonRef}
                        align="right"
                        width={210}
                        maxHeight={320}
                        onClose={() => setShowSettings(false)}
                    >
                        {showModelReasoningEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.reasoning')}
                                </div>
                                {codexReasoningEffortOptions
                                    .filter((option) => option.value !== null)
                                    .map((option) => renderMenuOption(
                                        option.value ?? 'default',
                                        modelReasoningEffort === option.value,
                                        formatReasoningLabel(option.value, option.label, locale),
                                        () => handleModelReasoningEffortChange(option.value)
                                    ))}
                            </div>
                        ) : null}

                        {!showModelReasoningEffortSettings && showEffortSettings ? (
                            <div className="py-2">
                                <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                    {t('misc.effort')}
                                </div>
                                {claudeEffortOptions.map((option) => renderMenuOption(
                                    option.value ?? 'auto',
                                    effort === option.value,
                                    option.label,
                                    () => handleEffortChange(option.value)
                                ))}
                            </div>
                        ) : null}

                        {(showModelReasoningEffortSettings || showEffortSettings) && (showModelSettings || showModelEffortSettings || showFastModeSettings) ? sectionDivider : null}

                        {showModelSettings || showModelEffortSettings
                            ? renderMenuRow('model', currentModelLabel, () => setSettingsPanel('model'))
                            : null}
                        {showFastModeSettings
                            ? renderMenuRow('speed', t('misc.speed'), () => setSettingsPanel('speed'))
                            : null}

                        {!showModelReasoningEffortSettings && !showEffortSettings && showCollaborationSettings ? (
                            <>
                                <div className="py-2">
                                    <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                                        {t('misc.collaborationMode')}
                                    </div>
                                    {collaborationModeOptions.map((option) => renderMenuOption(
                                        option.mode,
                                        collaborationMode === option.mode,
                                        option.label,
                                        () => handleCollaborationChange(option.mode)
                                    ))}
                                </div>
                            </>
                        ) : null}
                    </ToolbarMenu>
                </div>
            )
        }

        if (suggestions.length > 0) {
            return (
                <div className="absolute bottom-[100%] mb-2 w-full">
                    <FloatingOverlay>
                        <Autocomplete
                            suggestions={suggestions}
                            selectedIndex={selectedIndex}
                            onSelect={(index) => handleSuggestionSelect(index)}
                        />
                    </FloatingOverlay>
                </div>
            )
        }

        return null
    }, [
        showSettings,
        settingsPanel,
        showPiModelPanel,
        showPiThinkingPanel,
        agentFlavor,
        piModels,
        selectedPiModel,
        closeAllPanels,
        showCollaborationSettings,
        showPermissionSettings,
        showModelSettings,
        showModelEffortSettings,
        modelEffortOptions,
        selectedModelBase,
        selectedModelVariant,
        showModelReasoningEffortSettings,
        showEffortSettings,
        showFastModeSettings,
        modelOptions,
        piModelGroups,
        currentModelLabel,
        codexReasoningEffortOptions,
        claudeEffortOptions,
        fastModeOptions,
        suggestions,
        selectedIndex,
        controlsDisabled,
        collaborationMode,
        permissionMode,
        model,
        modelReasoningEffort,
        effort,
        serviceTier,
        collaborationModeOptions,
        permissionModeOptions,
        handleCollaborationChange,
        handlePermissionChange,
        handleModelChange,
        handleModelEffortChange,
        handleModelReasoningEffortChange,
        handleEffortChange,
        handleServiceTierChange,
        handleSuggestionSelect,
        locale,
        t
    ])

    return (
        <div
            className={`session-composer px-3 ${bottomPaddingClass} pt-2 transition-[padding] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none`}
            data-testid="happy-composer"
            data-mobile-layout-state={composerCompact ? 'compact' : 'expanded'}
        >
            <div
                ref={composerRootRef}
                className="mx-auto w-full max-w-content"
            >
                <ComposerPrimitive.Root
                    className="relative"
                    onSubmit={handleSubmit}
                    onMouseDownCapture={preserveComposerFocusForAction}
                >
                    {!composerCompact ? overlays : null}

                    {showStatusBar && shouldShowComposerStatusBar(agentFlavor) ? (
                        <StatusBar
                            active={active}
                            thinking={thinking}
                            agentState={agentState}
                            backgroundTaskCount={backgroundTaskCount}
                            contextSize={contextSize}
                            contextCacheRead={contextCacheRead}
                            contextWindow={contextWindow}
                            model={model}
                            modelReasoningEffort={modelReasoningEffort}
                            serviceTier={serviceTier}
                            permissionMode={permissionMode}
                            collaborationMode={collaborationMode}
                            threadGoal={threadGoal}
                            agentFlavor={agentFlavor}
                            voiceStatus={voiceStatus}
                        />
                    ) : null}

                    {!composerCompact && sendError ? (
                        <div
                            role="alert"
                            data-testid="composer-send-error"
                            className="mb-2 flex items-center justify-between gap-3 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-red-600"
                        >
                            <span className="flex-1">{sendError.message}</span>
                            {sendError.action ? (
                                <button
                                    type="button"
                                    data-testid="composer-send-error-action"
                                    onClick={sendError.action.onClick}
                                    disabled={sendError.action.pending}
                                    className="shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    {sendError.action.label}
                                </button>
                            ) : null}
                        </div>
                    ) : null}

                    {!composerCompact && hasSelectionChips ? (
                        <div className="mb-1 flex min-w-0 gap-1.5 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                            {selectedSkill ? (
                                <button
                                    type="button"
                                    data-testid="composer-selected-skill"
                                    aria-label={`Cancel skill ${selectedSkill.name}`}
                                    title={`$${selectedSkill.name}`}
                                    className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-500/10 px-2.5 text-sm font-semibold text-[var(--app-link)] transition-colors hover:bg-blue-500/15 dark:border-blue-400/30 dark:bg-blue-400/15 [&_svg]:h-4 [&_svg]:w-4"
                                    onClick={() => {
                                        setSelectedSkill(null)
                                        focusComposerInput()
                                        haptic('light')
                                    }}
                                >
                                    <Puzzle />
                                    <span className="whitespace-nowrap">{selectedSkill.name}</span>
                                </button>
                            ) : null}

                            {showPlanSelectionChip ? (
                                <button
                                    type="button"
                                    data-testid="composer-selected-plan-mode"
                                    aria-label={t('tool.exitPlan')}
                                    title={t('tool.exitPlan')}
                                    disabled={controlsDisabled}
                                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-blue-500/10 text-sm font-semibold text-[var(--app-link)] transition-colors hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-400/30 dark:bg-blue-400/15 [&_svg]:h-4 [&_svg]:w-4"
                                    onClick={handlePlanModeToggle}
                                >
                                    <PlanModeIcon />
                                </button>
                            ) : null}

                            {showGoalSelectionChip ? (
                                <button
                                    type="button"
                                    data-testid="composer-selected-goal-mode"
                                    aria-label="目标模式"
                                    title={threadGoal?.objective ? `目标模式: ${threadGoal.objective}` : '目标模式'}
                                    disabled={controlsDisabled}
                                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-blue-500/10 text-sm font-semibold text-[var(--app-link)] transition-colors hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-400/30 dark:bg-blue-400/15 [&_svg]:h-4 [&_svg]:w-4"
                                    onClick={() => haptic('light')}
                                >
                                    <GoalModeIcon />
                                </button>
                            ) : null}

                            {showSideSessionChip ? (
                                <button
                                    ref={sideSessionButtonRef}
                                    type="button"
                                    data-testid="composer-active-side-session"
                                    aria-label={activeSideSessions.length === 1 && firstActiveSideSession ? `打开侧边会话 ${firstActiveSideSession.title}` : '选择侧边会话'}
                                    title={activeSideSessions.length === 1 && firstActiveSideSession ? firstActiveSideSession.title : `${activeSideSessions.length} 个侧边会话`}
                                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-blue-500/10 text-sm font-semibold text-[var(--app-link)] transition-colors hover:bg-blue-500/15 dark:border-blue-400/30 dark:bg-blue-400/15 [&_svg]:h-4 [&_svg]:w-4"
                                    onClick={handleSideSessionChipClick}
                                >
                                    <SideSessionChipIcon />
                                </button>
                            ) : null}

                            {selectedRemoteServer && remoteServerAlias ? (
                                <button
                                    type="button"
                                    data-testid="composer-selected-remote-server"
                                    aria-label={`取消远程服务器 ${remoteServerAlias}`}
                                    title={`远程服务器: ${remoteServerAlias}`}
                                    disabled={controlsDisabled || isClearingRemoteServer}
                                    className="inline-flex h-7 max-w-[12rem] shrink-0 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-500/10 px-2.5 text-sm font-semibold text-[var(--app-link)] transition-colors hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-400/30 dark:bg-blue-400/15 [&_svg]:h-4 [&_svg]:w-4"
                                    onClick={() => { void handleClearRemoteServer() }}
                                >
                                    <ServerIcon className="h-4 w-4 shrink-0" />
                                    <span className="min-w-0 truncate">{remoteServerAlias}</span>
                                </button>
                            ) : null}
                        </div>
                    ) : null}

                    {!composerCompact && showSideSessionMenu && activeSideSessions.length > 1 ? (
                        <ToolbarMenu
                            anchorRef={sideSessionButtonRef}
                            align="left"
                            width={288}
                            maxHeight={320}
                            onClose={() => setShowSideSessionMenu(false)}
                        >
                            <div className="p-1">
                                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                                    侧边会话
                                </div>
                                {activeSideSessions.map((sideSession) => (
                                    <button
                                        key={sideSession.id}
                                        type="button"
                                        className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)]"
                                        onClick={() => handleSideSessionSelect(sideSession.id)}
                                    >
                                        <SideSessionChipIcon />
                                        <span className="min-w-0 flex-1 truncate">{sideSession.title}</span>
                                    </button>
                                ))}
                            </div>
                        </ToolbarMenu>
                    ) : null}

                    <div
                        className={`relative grid overflow-hidden border shadow-[0_10px_30px_rgba(15,23,42,0.08)] transition-[grid-template-rows,border-radius,border-color,box-shadow,background-color] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${composerGridRowsClass} ${
                            composerCompact
                                ? 'rounded-full border-[var(--app-border)] bg-[var(--app-bg)]'
                                : 'rounded-[22px] border-[var(--app-composer-expanded-border)] [background:var(--app-composer-expanded-bg)] [box-shadow:var(--app-composer-expanded-shadow)]'
                        } ${
                            sendError ? 'ring-1 ring-red-500' : ''
                        }`}
                    >
                        <div className="row-start-1 min-h-0 overflow-hidden">
                            {attachments.length > 0 ? (
                                <div className="flex flex-wrap gap-2 px-4 pt-3">
                                    <ComposerPrimitive.Attachments components={{ Attachment: AttachmentItem }} />
                                </div>
                            ) : null}
                        </div>

                        <div
                            onPointerDownCapture={handleComposerPointerDownCapture}
                            className={`relative row-start-2 flex min-w-0 px-4 transition-[padding] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none ${
                                composerCompact
                                    ? 'items-start py-3'
                                    : 'items-start py-2'
                            }`}
                        >
                            <ComposerPrimitive.Input
                                ref={textareaRef}
                                placeholder={composerCompact
                                    ? t('misc.compactComposerPrompt')
                                    : showContinueHint ? t('misc.typeMessage') : t('misc.typeAMessage')}
                                disabled={controlsDisabled}
                                maxRows={composerCompact ? 1 : 6}
                                submitOnEnter={false}
                                cancelOnEscape={false}
                                onFocus={handleComposerFocus}
                                onBlur={handleComposerBlur}
                                onChange={handleChange}
                                onSelect={handleSelect}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                className={`relative z-10 flex-1 resize-none bg-transparent text-base text-[var(--app-fg)] placeholder-[var(--app-hint)] transition-[height,min-height,max-height] duration-[220ms] ease-[cubic-bezier(0.2,0,0,1)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                                    composerCompact
                                        ? 'h-6 max-h-6 overflow-hidden pr-12 leading-6'
                                        : 'min-h-[44px] max-h-[10rem] overflow-y-auto overscroll-contain leading-snug'
                                }`}
                            />
                            {composerCompact ? (
                                <div className="absolute right-1 top-1/2 z-20 -translate-y-1/2">
                                    <UnifiedButton
                                        canSend={canSend}
                                        voiceStatus={voiceStatus}
                                        voiceEnabled={voiceEnabled}
                                        controlsDisabled={controlsDisabled}
                                        onSend={sendComposerMessage}
                                        onVoiceToggle={onVoiceToggle ?? (() => {})}
                                        showAbortButton={showAbortButton}
                                        abortDisabled={abortDisabled}
                                        isAborting={isAborting}
                                        onAbort={handleAbort}
                                        routesToScratchlist={compactRoutesToScratchlist}
                                    />
                                </div>
                            ) : null}
                        </div>

                        <div
                            aria-hidden={composerCompact || undefined}
                            inert={composerCompact}
                            className={`row-start-3 min-h-0 overflow-hidden transition-opacity motion-reduce:transition-none motion-reduce:delay-0 ${
                                composerCompact
                                    ? 'pointer-events-none opacity-0 duration-100 ease-in'
                                    : 'opacity-100 delay-[70ms] duration-[150ms] ease-out'
                            }`}
                        >
                            <ComposerButtons
                                canSend={canSend}
                                controlsDisabled={controlsDisabled}
                                showSettingsButton={showSettingsButton}
                                onSettingsToggle={handleSettingsToggle}
                                settingsButtonRef={settingsButtonRef}
                                settingsLabel={settingsLabel}
                                settingsModelLabel={compactModelLabel}
                                settingsReasoningLabel={currentReasoningLabel}
                                fastModeActive={serviceTier?.trim().toLowerCase() === 'fast'}
                                settingsOpen={showSettings}
                                contextUsagePercent={contextUsage?.percentage ?? null}
                                contextUsageLabel={contextUsage?.label}
                                contextUsageDetails={contextUsageDetails}
                                permissionMode={permissionMode}
                                permissionLabel={permissionLabel}
                                permissionModeOptions={permissionModeOptions}
                                onPermissionModeChange={showPermissionSettings ? handlePermissionChange : undefined}
                                skills={skills}
                                skillsLoading={skillsLoading}
                                skillsError={skillsError}
                                onSkillSelect={handleSkillSelect}
                                showPlanModeButton={showPlanModeTool}
                                planModeActive={collaborationMode === 'plan'}
                                onPlanModeToggle={showPlanModeTool ? handlePlanModeToggle : undefined}
                                showGoalModeButton={showGoalModeTool}
                                goalModeActive={threadGoal?.status === 'active'}
                                onGoalModeOpen={showGoalModeTool ? handleGoalModeOpen : undefined}
                                showTerminalButton={showTerminalButton}
                                terminalDisabled={terminalDisabled}
                                terminalLabel={terminalLabel}
                                onTerminal={onTerminal ?? (() => {})}
                                showAbortButton={showAbortButton}
                                abortDisabled={abortDisabled}
                                isAborting={isAborting}
                                onAbort={handleAbort}
                                showSwitchButton={showSwitchButton}
                                switchDisabled={switchDisabled}
                                isSwitching={isSwitching}
                                onSwitch={handleSwitch}
                                voiceEnabled={voiceEnabled}
                                voiceStatus={voiceStatus}
                                voiceMicMuted={voiceMicMuted}
                                onVoiceToggle={onVoiceToggle ?? (() => {})}
                                onVoiceMicToggle={onVoiceMicToggle}
                                onSend={sendComposerMessage}
                                pendingSchedule={pendingSchedule}
                                onSchedule={setPendingSchedule}
                                onClearSchedule={isControlled ? onClearScheduleProp : () => setPendingScheduleLocal(null)}
                                hasAttachments={hasAttachments}
                                piModelLabel={piModelLabel}
                                piModelButtonRef={piModelButtonRef}
                                piModelDisabled={controlsDisabled || !piHasModels}
                                piModelOpen={showPiModelPanel}
                                onPiModelToggle={handlePiModelToggle}
                                piThinkingLabel={piThinkingLabel}
                                piThinkingDisabled={controlsDisabled || !piHasModels || !selectedPiModel || selectedPiModel.reasoning === false}
                                piThinkingOpen={showPiThinkingPanel}
                                onPiThinkingToggle={handlePiThinkingToggle}
                                scratchlistMode={props.scratchlistMode}
                                scratchlistCount={props.scratchlistCount}
                                onScratchlistToggle={props.onScratchlistToggle}
                                remoteServerContext={remoteServerContext}
                                compact={false}
                            />
                        </div>
                    </div>
                </ComposerPrimitive.Root>
            </div>
        </div>
    )
}
