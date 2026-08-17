#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function source(relativePath: string): string {
    return readFileSync(resolve(repositoryRoot, relativePath), 'utf8')
}

function requireMatch(content: string, pattern: RegExp, rule: string): void {
    if (!pattern.test(content)) {
        throw new Error(`Mobile layout contract violation: ${rule}`)
    }
}

const css = source('web/src/index.css')
const contract = source('web/src/lib/mobileLayoutContract.ts')
const header = source('web/src/components/SessionHeader.tsx')
const composer = source('web/src/components/AssistantChat/HappyComposer.tsx')
const composerButtons = source('web/src/components/AssistantChat/ComposerButtons.tsx')
const sessionChat = source('web/src/components/SessionChat.tsx')
const happyThread = source('web/src/components/AssistantChat/HappyThread.tsx')
const queuedMessages = source('web/src/components/AssistantChat/QueuedMessagesBar.tsx')
const viewportHeight = source('web/src/hooks/useViewportHeight.ts')

// Approved visual values. Do not weaken this script to work around a change:
// obtain product approval, then update this guard and the contract document
// together so the approval is explicit in the diff.
requireMatch(contract, /background:\s*'transparent'/, 'header shell must stay transparent')
requireMatch(contract, /backdropFilter:\s*'none'/, 'header shell must not use a backdrop filter')
requireMatch(contract, /state:\s*'scrolls-under-transparent-header'/, 'thread must scroll under the transparent header')
requireMatch(contract, /state:\s*'floating-above-composer'/, 'bottom status must float above the composer')
requireMatch(contract, /keyboardOpenExpandedOffset:\s*'4px'/, 'expanded composer keyboard offset must stay 4px')

requireMatch(css, /--app-mobile-header-shell-background:\s*transparent\s*;/, 'CSS header background token must stay transparent')
requireMatch(css, /--app-mobile-header-shell-backdrop-filter:\s*none\s*;/, 'CSS header backdrop token must stay none')
requireMatch(css, /--app-mobile-composer-expanded-keyboard-offset:\s*4px\s*;/, 'CSS keyboard offset token must stay 4px')
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

requireMatch(header, /style=\{mobileLayoutHeaderShellStyle\}/, 'session header must use the canonical shell style')
requireMatch(header, /data-testid=\{MOBILE_LAYOUT_CONTRACT\.header\.testId\}/, 'session header must expose its contract target')
requireMatch(header, /data-mobile-layout-contract=\{MOBILE_LAYOUT_CONTRACT\.header\.state\}/, 'session header must expose its contract state')
requireMatch(header, /const headerSurfaceClass = 'border-\[color-mix\(in_srgb,var\(--app-fg\)_14%,var\(--app-bg\)\)\] bg-\[var\(--app-bg\)\]'/, 'header controls must stay independently solid')
requireMatch(header, /const headerShellClass = props\.floating\s*\? `pointer-events-auto absolute inset-x-0 top-0 z-20 isolate touch-manipulation/, 'floating header must remain an explicit iOS hit-test layer')
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
requireMatch(queuedMessages, /<Dialog\.Root/, 'queued messages must open from a controlled dialog root')
requireMatch(queuedMessages, /<Dialog\.Portal>/, 'queued-message detail must render in a portal')
requireMatch(queuedMessages, /data-testid="queued-messages-trigger"/, 'queued messages must expose a compact entry target')
requireMatch(queuedMessages, /data-testid="queued-messages-drawer"/, 'queued messages must expose a drawer target')
if (/backdrop-blur/.test(queuedMessages)) {
    throw new Error('Mobile layout contract violation: queued-message drawer must not add a glass blur')
}

console.log('Mobile layout contract verified.')
