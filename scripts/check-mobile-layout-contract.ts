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
const sessionChat = source('web/src/components/SessionChat.tsx')
const viewportHeight = source('web/src/hooks/useViewportHeight.ts')

// Approved visual values. Do not weaken this script to work around a change:
// obtain product approval, then update this guard and the contract document
// together so the approval is explicit in the diff.
requireMatch(contract, /background:\s*'transparent'/, 'header shell must stay transparent')
requireMatch(contract, /backdropFilter:\s*'none'/, 'header shell must not use a backdrop filter')
requireMatch(contract, /keyboardOpenExpandedOffset:\s*'4px'/, 'expanded composer keyboard offset must stay 4px')

requireMatch(css, /--app-mobile-header-shell-background:\s*transparent\s*;/, 'CSS header background token must stay transparent')
requireMatch(css, /--app-mobile-header-shell-backdrop-filter:\s*none\s*;/, 'CSS header backdrop token must stay none')
requireMatch(css, /--app-mobile-composer-expanded-keyboard-offset:\s*4px\s*;/, 'CSS keyboard offset token must stay 4px')
requireMatch(
    css,
    /html\[data-app-keyboard-open="true"\]\s*\{[\s\S]*?--app-composer-expanded-keyboard-offset:\s*var\(--app-mobile-composer-expanded-keyboard-offset\)\s*;/,
    'keyboard-open state must consume the canonical 4px token'
)
requireMatch(
    css,
    /html\[data-ios-standalone="true"\]\[data-ios-system-top-chrome="unreachable"\]\s*\{[\s\S]*?--app-safe-area-top:\s*env\(safe-area-inset-top,\s*0px\)\s*;/,
    'unreachable iOS system top chrome must not receive the 50px web fallback'
)

requireMatch(header, /style=\{mobileLayoutHeaderShellStyle\}/, 'session header must use the canonical shell style')
requireMatch(header, /data-testid=\{MOBILE_LAYOUT_CONTRACT\.header\.testId\}/, 'session header must expose its contract target')
requireMatch(header, /data-mobile-layout-contract=\{MOBILE_LAYOUT_CONTRACT\.header\.state\}/, 'session header must expose its contract state')
requireMatch(composer, /var\(--app-composer-expanded-keyboard-offset\)/, 'expanded composer must consume the keyboard offset token')
requireMatch(sessionChat, /bottomInset=\{bottomOverlayHeight \|\| undefined\}/, 'message thread must reserve the measured composer height')
requireMatch(viewportHeight, /getIosStandaloneSystemTopChromeState/, 'viewport hook must detect unreachable iOS top chrome')
requireMatch(viewportHeight, /data-ios-system-top-chrome', 'unreachable'/, 'viewport hook must mark unreachable iOS top chrome')
requireMatch(viewportHeight, /safeAreaTopInset\s*<=\s*0/, 'iOS top-chrome detection must require a zero browser safe-area inset')

console.log('Mobile layout contract verified.')
