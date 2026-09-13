#!/usr/bin/env bun

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function source(relativePath: string): string {
    return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

function requireMatch(content: string, pattern: RegExp, rule: string): void {
    if (!pattern.test(content)) {
        throw new Error(`Mobile layout contract violation: ${rule}`)
    }
}

function collectSourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const filePath = join(directory, entry.name)
        if (entry.isDirectory()) {
            return collectSourceFiles(filePath)
        }
        return /\.(?:css|ts|tsx)$/.test(entry.name) ? [filePath] : []
    })
}

function requireCanonicalSafeAreaConsumers(): void {
    const rawSafeAreaPattern = /env\(safe-area-inset-(?:top|right|bottom|left)\b/
    const cssPath = resolve(repositoryRoot, 'web/src/index.css')
    const viewportHeightPath = resolve(repositoryRoot, 'web/src/hooks/useViewportHeight.ts')

    for (const filePath of collectSourceFiles(resolve(repositoryRoot, 'web/src'))) {
        const absolutePath = resolve(filePath)
        const content = readFileSync(filePath, 'utf8')
        if (absolutePath === cssPath) continue

        // This single probe must read the browser value to detect WebKit's
        // system-owned top strip; all rendered components consume CSS tokens.
        const contentWithoutProbe = absolutePath === viewportHeightPath
            ? content.replace("'padding-top:env(safe-area-inset-top, 0px)'", '')
            : content
        if (rawSafeAreaPattern.test(contentWithoutProbe)) {
            throw new Error(`Mobile layout contract violation: ${filePath} must consume canonical --app-safe-area-* variables`)
        }
    }
}

const css = source('web/src/index.css')
const contract = source('web/src/lib/mobileLayoutContract.ts')
const header = source('web/src/components/SessionHeader.tsx')
const toastContainer = source('web/src/components/ToastContainer.tsx')
const composer = source('web/src/components/AssistantChat/HappyComposer.tsx')
const composerButtons = source('web/src/components/AssistantChat/ComposerButtons.tsx')
const sessionChat = source('web/src/components/SessionChat.tsx')
const happyThread = source('web/src/components/AssistantChat/HappyThread.tsx')
const queuedMessages = source('web/src/components/AssistantChat/QueuedMessagesBar.tsx')
const queueTrigger = source('web/src/components/SessionDetailQueueTrigger.tsx')
const bottomDock = source('web/src/components/SessionDetailBottomDock.tsx')
const viewportHeight = source('web/src/hooks/useViewportHeight.ts')

if (/composer-thinking-slot|<SessionThinkingIndicator/.test(source('web/src/components/AssistantChat/HappyComposer.tsx'))
    || /<SessionThinkingIndicator/.test(source('web/src/components/AssistantChat/StatusBar.tsx'))
    || /styles\/dot\.css/.test(source('web/src/components/assistant-ui/markdown-text.tsx'))) {
    throw new Error('Thinking must be a standalone thread row, without composer space or Markdown dots')
}
requireMatch(sessionChat, /<ThreadThinkingMessage/, 'managed sessions must render thread thinking feedback')
requireMatch(source('web/src/components/CodexSessionContextPage.tsx'), /<ThreadThinkingMessage/, 'native sessions must render thread thinking feedback')

// Approved visual values. Do not weaken this script to work around a change:
// obtain product approval, then update this guard and the contract document
// together so the approval is explicit in the diff.
requireMatch(contract, /background:\s*'transparent'/, 'header shell must stay transparent')
requireMatch(contract, /backdropFilter:\s*'none'/, 'header shell must not use a backdrop filter')
requireMatch(contract, /state:\s*'scrolls-under-transparent-header'/, 'thread must scroll under the transparent header')
requireMatch(contract, /state:\s*'floating-above-composer'/, 'bottom status must float above the composer')
requireMatch(contract, /keyboardOpenExpandedOffset:\s*'4px'/, 'expanded composer keyboard offset must stay 4px')
requireMatch(contract, /inputDialog:[\s\S]*?state:\s*'visual-viewport-keyboard-safe'/, 'editable-detail dialogs must stay visual-viewport safe')
requireMatch(contract, /keyboardGap:\s*'8px'/, 'editable-detail keyboard gap must stay 8px')
requireMatch(contract, /edgeGap:\s*'12px'/, 'editable-detail dialog edge gap must stay 12px')

requireMatch(css, /--app-mobile-header-shell-background:\s*transparent\s*;/, 'CSS header background token must stay transparent')
requireMatch(css, /--app-mobile-header-shell-backdrop-filter:\s*none\s*;/, 'CSS header backdrop token must stay none')
requireMatch(css, /--app-mobile-composer-expanded-keyboard-offset:\s*4px\s*;/, 'CSS keyboard offset token must stay 4px')
requireMatch(css, /--app-mobile-input-dialog-keyboard-gap:\s*8px\s*;/, 'editable-detail keyboard gap must have one contract token')
requireMatch(css, /--app-mobile-input-dialog-edge-gap:\s*12px\s*;/, 'editable-detail dialog edge gap must have one contract token')
requireMatch(css, /--app-safe-area-top:\s*env\(safe-area-inset-top,\s*0px\)\s*;/, 'top safe-area token must own the browser inset')
requireMatch(css, /--app-safe-area-right:\s*env\(safe-area-inset-right,\s*0px\)\s*;/, 'right safe-area token must own the browser inset')
requireMatch(css, /--app-safe-area-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)\s*;/, 'bottom safe-area token must own the browser inset')
requireMatch(css, /--app-safe-area-left:\s*env\(safe-area-inset-left,\s*0px\)\s*;/, 'left safe-area token must own the browser inset')
requireMatch(css, /--app-composer-expanded-bottom-gap:\s*0\.75rem\s*;/, 'expanded composer base gap must stay 12px outside keyboard state')
requireMatch(
    css,
    /html\[data-app-keyboard-open="true"\]\s*\{[\s\S]*?--app-composer-safe-area-bottom:\s*0px\s*;[\s\S]*?--app-composer-expanded-bottom-gap:\s*0px\s*;[\s\S]*?--app-composer-expanded-keyboard-offset:\s*var\(--app-mobile-composer-expanded-keyboard-offset\)\s*;/,
    'expanded keyboard state must leave a total 4px bottom gap'
)
requireMatch(
    css,
    /html\[data-ios-standalone="true"\]\[data-ios-system-top-chrome="unreachable"\]\s*\{[\s\S]*?--app-safe-area-top:\s*env\(safe-area-inset-top,\s*0px\)\s*;/,
    'unreachable iOS system top chrome must not receive the 50px web fallback'
)
requireCanonicalSafeAreaConsumers()

requireMatch(header, /style=\{mobileLayoutHeaderShellStyle\}/, 'session header must use the canonical shell style')
requireMatch(header, /data-testid=\{MOBILE_LAYOUT_CONTRACT\.header\.testId\}/, 'session header must expose its contract target')
requireMatch(header, /data-mobile-layout-contract=\{MOBILE_LAYOUT_CONTRACT\.header\.state\}/, 'session header must expose its contract state')
requireMatch(header, /const headerSurfaceClass = 'border-\[color-mix\(in_srgb,var\(--app-fg\)_14%,var\(--app-bg\)\)\] bg-\[var\(--app-bg\)\]'/, 'header controls must stay independently solid')
requireMatch(header, /const headerShellClass = props\.floating[\s\S]*?\? `pointer-events-none absolute inset-x-0 top-0 z-40 isolate/, 'floating header shell must pass empty-area touches through to the conversation')
requireMatch(css, /--app-toast-top:\s*calc\(var\(--app-safe-area-top\) \+ 5rem\)/, 'toast offset must derive from the canonical top safe-area token')
requireMatch(toastContainer, /top-\[var\(--app-toast-top\)\]/, 'non-modal toast must stay below the floating header controls')
requireMatch(composer, /var\(--app-composer-expanded-bottom-gap\)\+var\(--app-composer-safe-area-bottom\)\+var\(--app-composer-expanded-keyboard-offset\)/, 'expanded composer must consume the canonical keyboard gap tokens')
requireMatch(composer, /const requiresExpandedComposer = hasText\s*\|\|/, 'a non-empty draft must keep the composer expanded')
requireMatch(composer, /const composerCompact = !composerExpanded && !requiresExpandedComposer/, 'the visual compact state must honor the non-empty draft invariant')
requireMatch(composer, /grid-rows-\[0fr_auto_1fr\]/, 'expanded composer text row must grow with multi-line input')
if (/grid-rows-\[0fr_62px_1fr\]|grid-rows-\[auto_62px_1fr\]/.test(composer)) {
    throw new Error('Mobile layout contract violation: a fixed expanded text row can cover composer buttons')
}
requireMatch(composer, /<ComposerPrimitive\.Root[\s\S]*?onMouseDownCapture=\{preserveComposerFocusForAction\}/, 'every composer action must preserve focus at mousedown')
requireMatch(composer, /<ToolbarMenu[\s\S]*?anchorRef=\{settingsButtonRef\}/, 'settings menu must use the visual-viewport toolbar menu')
requireMatch(composerButtons, /export function computeToolbarMenuPlacement/, 'composer menus must calculate visual-viewport placement')
requireMatch(composerButtons, /window\.visualViewport\?\.addEventListener\('resize', measure/, 'composer menus must react to visual-viewport changes')
requireMatch(composerButtons, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/, 'send button must preserve focus at mousedown')
requireMatch(composerButtons, /COMPOSER_TOOLBAR_HORIZONTAL_PADDING_PX\s*=\s*12/, 'composer optional controls must use the real horizontal padding')
requireMatch(composerButtons, /COMPOSER_TOOLBAR_GAP_PX\s*=\s*2/, 'composer optional controls must use the real toolbar gap')
if (/compactTopAnchor/.test(composer) || /h-\[120px\]|h-\[150px\]/.test(composer)) {
    throw new Error('Mobile layout contract violation: status visibility must not reserve composer height')
}
if (/onPointerDownCapture=\{preserveComposerFocusForAction\}/.test(composer)) {
    throw new Error('Mobile layout contract violation: composer actions must not cancel pointerdown')
}
if (/onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/.test(composerButtons)
    || /onPointerDown=\{\(event\) => \{\s*event\.preventDefault\(\)/.test(composerButtons)) {
    throw new Error('Mobile layout contract violation: composer buttons must not cancel pointerdown')
}
requireMatch(sessionChat, /bottomInset=\{threadBottomInset \|\| undefined\}/, 'message thread must reserve the measured bottom overlay and status height')
requireMatch(sessionChat, /getBottomOverlayThreadInset\(/, 'message thread must reserve the floating status height separately')
requireMatch(sessionChat, /ref=\{bottomAccessoryRef\}/, 'bottom status must have a measured floating layer')
requireMatch(sessionChat, /data-testid=\{MOBILE_LAYOUT_CONTRACT\.bottomAccessory\.testId\}/, 'bottom status must expose its contract target')
requireMatch(sessionChat, /data-mobile-layout-contract=\{MOBILE_LAYOUT_CONTRACT\.bottomAccessory\.state\}/, 'bottom status must expose its contract state')
requireMatch(
    sessionChat,
    /ref=\{bottomAccessoryRef\}[\s\S]*?<QueuedMessagesBar[\s\S]*?queuedMessages=\{queuedMessages\}/,
    'queued-message entry must live in the measured floating accessory layer'
)
requireMatch(sessionChat, /topInset=\{FLOATING_SESSION_HEADER_HEIGHT_PX\}/, 'message thread must always receive the measured header height')
requireMatch(happyThread, /getThreadContentPadding\(props\)/, 'thread content must reserve the initial header clearance')
if (/style=\{getThreadViewportPadding\(props\)\}/.test(happyThread)) {
    throw new Error('Mobile layout contract violation: thread viewport must remain edge-to-edge below the transparent header')
}
requireMatch(happyThread, /data-testid=\{MOBILE_LAYOUT_CONTRACT\.thread\.testId\}/, 'thread root must expose its contract target')
requireMatch(happyThread, /data-mobile-layout-contract=\{MOBILE_LAYOUT_CONTRACT\.thread\.state\}/, 'thread root must expose its contract state')
requireMatch(viewportHeight, /getIosStandaloneSystemTopChromeState/, 'viewport hook must detect unreachable iOS top chrome')
requireMatch(viewportHeight, /data-ios-system-top-chrome', 'unreachable'/, 'viewport hook must mark unreachable iOS top chrome')
requireMatch(viewportHeight, /safeAreaTopInset\s*<=\s*0/, 'iOS top-chrome detection must require a zero browser safe-area inset')
requireMatch(queuedMessages, /<BottomDrawer open=\{open[^}]*\} onOpenChange=\{setOpen\}/, 'queued messages must use the shared portal drawer')
requireMatch(queuedMessages, /<SessionDetailQueueTrigger[\s\S]*testId="queued-messages-trigger"/, 'SHAPI queue must use the shared compact entry target')
requireMatch(queueTrigger, /data-testid=\{testId\}/, 'shared queue trigger must expose its compact entry target')
requireMatch(queuedMessages, /testId="queued-messages-drawer"/, 'queued messages must expose a drawer target')
requireMatch(source('web/src/components/NativeQueuedMessagesBar.tsx'), /<BottomDrawer open=\{open[^}]*\} onOpenChange=\{setOpen\}/, 'native queue must use the same drawer')
requireMatch(bottomDock, /SESSION_DETAIL_BOTTOM_ACCESSORY_GAP_PX/, 'detail pages must share one accessory gap')
if (/backdrop-blur/.test(queuedMessages)) {
    throw new Error('Mobile layout contract violation: queued-message drawer must not add a glass blur')
}


const chatDrawer = source('web/src/components/ui/BottomDrawer.tsx')
const drawerCss = source('web/src/index.css')
requireMatch(chatDrawer, /inputDialog\?: boolean/, 'editable-detail drawers must expose the shared dialog presentation')
requireMatch(chatDrawer, /data-keyboard-safe-dialog/, 'editable-detail dialogs must expose their keyboard-safe surface')
requireMatch(chatDrawer, /window\.visualViewport\?\.addEventListener\('resize', onVisualResize\)/, 'editable-detail dialogs must react to visual viewport changes')
requireMatch(chatDrawer, /--drawer-keyboard-bottom/, 'keyboard-open dialog must distinguish the fixed-position viewport from the layout viewport')
requireMatch(chatDrawer, /bottom: viewport\?\.keyboardOpen[\s\S]*?'calc\(var\(--drawer-keyboard-bottom\) \+ var\(--app-mobile-input-dialog-keyboard-gap\)\)'[\s\S]*?'calc\(var\(--app-safe-area-bottom\) \+ var\(--app-mobile-input-dialog-edge-gap\)\)'/, 'editable dialog must use separate keyboard-open and keyboard-closed bottom anchors')
requireMatch(chatDrawer, /maxHeight: 'calc\(var\(--drawer-viewport-height\) - var\(--app-safe-area-top\) - var\(--app-mobile-input-dialog-edge-gap\) - var\(--app-mobile-input-dialog-edge-gap\)\)'/, 'editable-detail dialog must stay within the visual viewport')
requireMatch(chatDrawer, /left: 'calc\(var\(--app-safe-area-left\) \+ var\(--app-mobile-input-dialog-edge-gap\)\)'/, 'editable-detail dialog must anchor to the left safe-area edge')
requireMatch(chatDrawer, /right: 'calc\(var\(--app-safe-area-right\) \+ var\(--app-mobile-input-dialog-edge-gap\)\)'/, 'editable-detail dialog must anchor to the right safe-area edge')
requireMatch(chatDrawer, /transform: 'none'/, 'keyboard-open editable dialog must not retain a horizontal translate')
requireMatch(chatDrawer, /if \(keyboardSafeDialog\)[\s\S]*?<Dialog\.Portal>[\s\S]*?<Dialog\.Content/, 'mobile input dialogs must use their own portal branch')
for (const [path, rule] of [
    ['web/src/components/RenameSessionDialog.tsx', 'session rename must use the keyboard-safe dialog'],
    ['web/src/components/SessionGroupDrawer.tsx', 'session group editing must use the keyboard-safe dialog'],
    ['web/src/components/GitBranchesDrawer.tsx', 'Git input flows must use the keyboard-safe dialog'],
    ['web/src/components/ToolCard/QuestionAnswerForm.tsx', 'question text input must use the keyboard-safe dialog']
] as const) {
    requireMatch(source(path), /inputDialog/, rule)
}
if (/\binputDialog\b/.test(source('web/src/components/SessionFiles/SessionFilesDrawer.tsx'))) {
    throw new Error('Mobile layout contract violation: file browsing must remain a bottom drawer')
}
requireMatch(drawerCss, /html\[data-drawer-chrome='true'\]/, 'drawer chrome tint must be root paint, not a layout spacer')
requireMatch(source('web/src/lib/drawer-background.ts'), /setDrawerChromeProgress\(progress\)/, 'drawer chrome must follow the shared nested drawer progress')
requireMatch(drawerCss, /--app-mobile-detail-sheet-ratio:\s*0\.7\s*;/, 'mobile chat detail sheets must default to 70%')
requireMatch(drawerCss, /--drawer-expanded-height:[^;]*--app-safe-area-top[^;]*12px/, 'expanded drawers must stop below the top safe area')
requireMatch(chatDrawer, /role="separator" tabIndex=\{0\}/, 'drawer handle must preserve keyboard resizing')
if (/ChevronsUp|ChevronsDown/.test(chatDrawer)) throw new Error('Drawers must not display separate expand/collapse icons')
requireMatch(drawerCss, /--app-detail-sheet-duration:\s*500ms/, 'drawer entrance must take 500ms')
requireMatch(drawerCss, /--app-detail-sheet-exit-duration:\s*400ms/, 'drawer exits must take 400ms')
requireMatch(drawerCss, /--app-detail-background-return-ease:\s*cubic-bezier\(0\.42, 0, 0\.58, 1\)/, 'background return must not reuse the fast-start sheet entrance curve')
for (const selector of ["html[data-drawer-chrome-closing='true'], html[data-drawer-chrome-closing='true'] body", ".chat-drawer-stage:has([data-drawer-closing='true'])", ":is([data-chat-drawer-background], [data-drawer-page-background])[data-drawer-closing='true']"]) {
    const rule = drawerCss.slice(drawerCss.indexOf(selector)).split('}')[0]
    requireMatch(rule, /transition-timing-function:\s*var\(--app-detail-background-return-ease\)/, 'all background surfaces must return with the same gentle curve')
}
requireMatch(drawerCss, /--app-detail-sheet-settle-duration:\s*300ms/, 'drawer settling must take 300ms')
requireMatch(chatDrawer, /duration:\s*300,/, 'drawer detent resizing must take 300ms')
requireMatch(drawerCss, /max-height:\s*min\(calc\(var\(--drawer-viewport-height,\s*100dvh\)\s*\*\s*var\(--app-mobile-detail-sheet-ratio\)\)/, 'detail sheet cap must follow the visual viewport')
requireMatch(chatDrawer, /<Dialog\.Portal>/, 'chat drawers must remain outside the composer document flow')
requireMatch(chatDrawer, /data-chat-drawer-body/, 'chat sheet body must expose its scrolling surface')
requireMatch(chatDrawer, /overflow-y-auto overscroll-contain/, 'chat sheet body must scroll without moving the chat')
requireMatch(chatDrawer, /onPointerCancel/, 'cancelled drawer drags must spring back')
requireMatch(drawerCss, /prefers-reduced-motion:[\s\S]*data-chat-drawer-background/, 'background recession must respect reduced motion')

const localServiceDrawer = source('web/src/components/ChatPreviewDrawer.tsx')
requireMatch(localServiceDrawer, /presentation:\s*'embed'/, 'local service links must request a direct embedded preview')
requireMatch(localServiceDrawer, /page\.data\.mode !== 'embed'[\s\S]*chatPreview\.blocked/, 'blocked public pages must display an unavailable message instead of reader content')
requireMatch(source('web/src/styles/chat-overlays.css'), /data-testid="session-files-drawer"[\s\S]*padding-top:\s*0/, 'file drawer header spacing must stay compact and scoped')
requireMatch(localServiceDrawer, /sandbox="allow-scripts allow-forms"/, 'embedded local services must stay isolated from chat login storage')
requireMatch(localServiceDrawer, /<DetailCopyButton[^>]*new URL\(preview\.url, window\.location\.href\)\.href[^>]*chatPreview\.copyLink[^>]*iconOnly/, 'web previews must offer an icon to copy the absolute original or local-service launch URL')
if (/chatPreview\.(?:frameHint|localServiceHint|openExternal)|openLocalServiceInTab/.test(localServiceDrawer)) {
    throw new Error('Mobile layout contract violation: web previews must show the page directly without a permanent browser fallback prompt')
}

console.log('Mobile layout contract verified.')
