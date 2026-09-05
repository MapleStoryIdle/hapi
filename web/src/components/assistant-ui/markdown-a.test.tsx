/**
 * Tests for the custom <A> anchor component and the inlined URL policy helpers
 * in markdown-text.tsx.
 *
 * Covers:
 *   - classifyScheme: IANA / deny / custom, 6-axis security bypass
 *   - denyOnlyTransform: deny → "", IANA/custom → pass-through, relative paths
 *   - useAllowedSchemes (inlined): localStorage roundtrip, cross-tab storage event, tamper guard
 *   - <A> component click behaviour: deny, IANA, custom (dialog opened via context)
 *   - intra-tab cross-provider sync via module-level schemeListeners emitter
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import React from 'react'
import { defaultComponents, classifyScheme, denyOnlyTransform, UriConfirmProvider } from '@/components/assistant-ui/markdown-text'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider, type HappyChatFileLinkTarget } from '@/components/AssistantChat/context'
import { encodeBase64 } from '@/lib/utils'
import { parseLocalServiceLaunchHash } from '@/lib/local-service-links'
import * as localServiceNavigation from '@/lib/open-local-service'

const routerMocks = vi.hoisted(() => ({
    navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => routerMocks.navigate,
}))

// defaultComponents.a is the memoized A component.
const AnchorComponent = (defaultComponents as Record<string, unknown>).a as React.ComponentType<
    React.ComponentPropsWithoutRef<'a'>
>

// Helper: wrap A in UriConfirmProvider so useContext(UriConfirmContext) is non-null.
// Previously <A> had a localHook fallback for bare renders, but that fallback
// added a storage listener per link (N links → N+1 listeners). The fallback is
// removed; tests must provide the context instead.
function renderA(props: React.ComponentPropsWithoutRef<'a'>) {
    return render(
        <I18nProvider>
            <UriConfirmProvider>
                <AnchorComponent {...props} />
            </UriConfirmProvider>
        </I18nProvider>
    )
}

function renderAInChat(
    props: React.ComponentPropsWithoutRef<'a'>,
    options?: { fileLinkTarget?: HappyChatFileLinkTarget; workspacePath?: string }
) {
    return render(
        <I18nProvider>
            <HappyChatProvider value={{
                api: {} as never,
                sessionId: 'session-1',
                metadata: { path: options?.workspacePath ?? 'repo', host: 'local' },
                terminalToolDisplayMode: 'compact',
                disabled: false,
                onRefresh: vi.fn(),
                hasMoreMessages: false,
                isLoadingMoreMessages: false,
                loadOlderMessagesPreservingScroll: vi.fn(async () => false),
                ...(options?.fileLinkTarget ? { fileLinkTarget: options.fileLinkTarget } : {}),
            }}>
                <UriConfirmProvider>
                    <AnchorComponent {...props} />
                </UriConfirmProvider>
            </HappyChatProvider>
        </I18nProvider>
    )
}

const STORAGE_KEY = 'hapi-allowed-schemes'

describe('automatic local service links', () => {
    it('hands a normal tap to the authenticated chat without opening the login route', () => {
        const open = vi.spyOn(localServiceNavigation, 'openLocalServiceInTab').mockReturnValue(true)
        renderAInChat({ href: 'http://localhost:8317/settings', children: 'Open service' })
        expect(open).not.toHaveBeenCalled()
        const dispatched = fireEvent.click(screen.getByRole('link', { name: 'Open service' }))
        expect(dispatched).toBe(false)
        expect(open).toHaveBeenCalledWith(expect.anything(), {
            source: { type: 'session', sessionId: 'session-1' }, url: 'http://localhost:8317/settings'
        }, expect.objectContaining({ opening: expect.any(String) }))
    })

    it('does not override an explicitly cancelled click', () => {
        const open = vi.spyOn(localServiceNavigation, 'openLocalServiceInTab').mockReturnValue(true)
        renderAInChat({ href: 'http://localhost:8317/', children: 'Open service', onClick: (event) => event.preventDefault() })
        fireEvent.click(screen.getByRole('link', { name: 'Open service' }))
        expect(open).not.toHaveBeenCalled()
    })

    it.each(['http://localhost:8317/settings?a=1#tab', 'http://127.0.0.1:3000', 'https://[::1]:4443/'])('opens %s through its managed session without calling an API while rendering', (href) => {
        renderAInChat({ href, children: 'Open service' })
        const link = screen.getByRole('link', { name: 'Open service' }) as HTMLAnchorElement
        expect(link).toHaveAttribute('target', '_blank')
        expect(link).toHaveAttribute('rel', 'noopener noreferrer')
        expect(parseLocalServiceLaunchHash(new URL(link.href).hash)).toEqual({ source: { type: 'session', sessionId: 'session-1' }, url: href })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(routerMocks.navigate).not.toHaveBeenCalled()
    })

    it('uses the native source machine rather than the viewing phone', () => {
        const source = { type: 'native-codex' as const, sessionId: 'native-2', machineId: 'machine-2' }
        renderAInChat({ href: 'http://localhost:9000/', children: 'Native service' }, { fileLinkTarget: source })
        const link = screen.getByRole('link', { name: 'Native service' }) as HTMLAnchorElement
        expect(parseLocalServiceLaunchHash(new URL(link.href).hash)?.source).toEqual(source)
    })
})

beforeEach(() => {
    localStorage.clear()
    cleanup()
    routerMocks.navigate.mockClear()
    vi.clearAllMocks()
})
afterEach(() => vi.restoreAllMocks())

// ── classifyScheme ────────────────────────────────────────────────────────────

describe('classifyScheme — IANA schemes', () => {
    it.each(['https://example.com', 'http://example.com', 'mailto:user@x.com', 'irc://irc.libera.chat', 'ircs://irc.libera.chat', 'xmpp:user@x.com'])(
        'classifies %s as iana',
        (url) => expect(classifyScheme(url)).toBe('iana')
    )
    it('classifies HTTPS: (uppercase) as iana (case-insensitive)', () => {
        expect(classifyScheme('HTTPS://example.com')).toBe('iana')
    })
})

describe('classifyScheme — deny schemes', () => {
    it.each(['javascript:alert(1)', 'data:text/html,<h1>xss</h1>', 'vbscript:msgbox(1)', 'file:///tmp/test.txt'])(
        'classifies %s as deny',
        (url) => expect(classifyScheme(url)).toBe('deny')
    )
})

describe('classifyScheme — custom schemes', () => {
    it.each(['obsidian://open?vault=V&file=F', 'vscode://file/path', 'slack://channel?team=T123'])(
        'classifies %s as custom',
        (url) => expect(classifyScheme(url)).toBe('custom')
    )
})

describe('classifyScheme — security bypass axes', () => {
    // (a) case bypass
    it.each(['JavaScript:alert(1)', 'JAVASCRIPT:alert(1)'])('blocks %s (case) as deny', (url) =>
        expect(classifyScheme(url)).toBe('deny')
    )
    // (b) whitespace prefix on entire URL
    it.each(['\tjavascript:alert(1)', '\njavascript:alert(1)', ' javascript:alert(1)'])('blocks %s (whitespace prefix) as deny', (url) =>
        expect(classifyScheme(url)).toBe('deny')
    )
    // (c) percent-encoding
    it('%6Aavascript: (encoded j) → deny', () => expect(classifyScheme('%6Aavascript:alert(1)')).toBe('deny'))
    it('jav%61script: (encoded a) → deny', () => expect(classifyScheme('jav%61script:alert(1)')).toBe('deny'))
    // (d) double-encoding — 2-pass decode unwraps javascript%253A → javascript%3A → javascript:
    // With 2-pass decode, the second pass resolves %3A → literal colon, so the scheme
    // "javascript" is extracted and hits DENY_SCHEMES → 'deny' via scheme-match.
    it('javascript%253A (double-encoded colon) → deny', () => expect(classifyScheme('javascript%253Aalert(1)')).toBe('deny'))
    // `javascript%3Aalert(1)` — single-encoded colon. decodeURIComponent yields
    // `javascript:alert(1)` with a literal colon, so classifyScheme extracts scheme
    // "javascript" → hits DENY_SCHEMES → 'deny'. This is the real scheme-match path.
    it('javascript%3A (single-encoded colon) → deny via scheme-match', () => expect(classifyScheme('javascript%3Aalert(1)')).toBe('deny'))
    // (e) control characters spliced into scheme name
    // Browsers strip \n, \t, \r from URL schemes during navigation; our normalizer
    // must do the same before comparing against the deny list.
    it('java\\nscript: (newline in scheme) → deny', () => expect(classifyScheme('java\nscript:alert(1)')).toBe('deny'))
    it('java\\tscript: (tab in scheme) → deny', () => expect(classifyScheme('java\tscript:alert(1)')).toBe('deny'))
    it('java\\rscript: (carriage return in scheme) → deny', () => expect(classifyScheme('java\rscript:alert(1)')).toBe('deny'))
    it('java script: (space in scheme) → deny', () => expect(classifyScheme('java script:alert(1)')).toBe('deny'))
    // percent-encoded control chars inside the scheme — decoded by pass 1 then stripped
    it('java%0Ascript: (percent-encoded newline in scheme) → deny', () => expect(classifyScheme('java%0Ascript:alert(1)')).toBe('deny'))
    // leading whitespace on the URL itself (already covered by trimStart, added for completeness)
    it('\\tjavascript: (leading tab on URL) → deny', () => expect(classifyScheme('\tjavascript:alert(1)')).toBe('deny'))
    // case sanity (also covered above but keep explicit)
    it('JAVASCRIPT: → deny', () => expect(classifyScheme('JAVASCRIPT:alert(1)')).toBe('deny'))
    it('JaVaScRipT: → deny', () => expect(classifyScheme('JaVaScRipT:')).toBe('deny'))
    // edge
    it('empty string → deny', () => expect(classifyScheme('')).toBe('deny'))
    it('no-colon string → deny', () => expect(classifyScheme('not-a-url')).toBe('deny'))
})

// ── denyOnlyTransform ─────────────────────────────────────────────────────────

describe('denyOnlyTransform', () => {
    it.each(['javascript:alert(1)', 'data:text/html,xss', 'vbscript:x', 'file:///tmp/f', 'JavaScript:alert(1)', 'jav%61script:alert(1)', '%6Aavascript:alert(1)'])(
        'strips %s → ""',
        (url) => expect(denyOnlyTransform(url)).toBe('')
    )
    it.each([
        'data:image/png;base64,iVBORw0KGgo=',
        'data:image/svg+xml,<svg></svg>',
        'data:text/html,<h1>xss</h1>',
        'data:application/javascript,alert(1)'
    ])(
        'keeps data URL %s stripped',
        (url) => expect(denyOnlyTransform(url)).toBe('')
    )
    it.each(['https://example.com', 'http://example.com', 'mailto:a@b.com'])(
        'passes %s through unchanged',
        (url) => expect(denyOnlyTransform(url)).toBe(url)
    )
    it.each(['obsidian://open?vault=V', 'vscode://file/path', 'slack://channel'])(
        'passes custom scheme %s through unchanged',
        (url) => expect(denyOnlyTransform(url)).toBe(url)
    )
    it('passes relative path through', () => {
        expect(denyOnlyTransform('/relative/path')).toBe('/relative/path')
    })
})

// ── useAllowedSchemes (inlined hook, tested via A component) ──────────────────

describe('localStorage roundtrip via A component', () => {
    it('renders href="#" for unallowed custom scheme', () => {
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')
    })

    it('renders real href for pre-seeded allowed custom scheme', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['obsidian']))
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('obsidian://open?vault=V&file=F')
    })

    it('isAllowed returns false for deny scheme even if tampered into localStorage', () => {
        // Tamper: put javascript into allowed list
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['javascript']))
        // The A component should still not treat javascript as allowed (it classifies to 'deny')
        renderA({ href: 'javascript:alert(1)', children: 'evil' })
        // href="" comes from denyOnlyTransform; onclick should preventDefault
        const link = document.querySelector('a')!
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        link.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })
})

describe('cross-tab sync via storage event', () => {
    it('updates after storage event fires (simulated other-tab write)', () => {
        // Start with empty storage, render an unallowed custom link
        renderA({ href: 'obsidian://open', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')

        // Simulate another tab writing the allowed schemes
        act(() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(['obsidian']))
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: JSON.stringify(['obsidian']),
                storageArea: localStorage,
            }))
        })

        // After storage event the hook re-reads; re-render the component
        cleanup()
        renderA({ href: 'obsidian://open', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('obsidian://open')
    })
})

// ── <A> component — click handler ────────────────────────────────────────────

describe('markdown <A> component — click handler', () => {
    it('prevents default when href is empty string (deny-scheme link)', () => {
        renderA({ href: '', children: 'deny' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })

    it('renders empty href for direct data links', () => {
        renderA({ href: 'data:image/png;base64,iVBORw0KGgo=', children: 'image link' })
        const link = document.querySelector('a')!
        expect(link.getAttribute('href')).toBe('')

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        link.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })

    it('prevents default when href is undefined', () => {
        renderA({ children: 'no href' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })

    it('renders href="#" for an unallowed custom scheme (no middle-click bypass)', () => {
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')
    })

    it('renders the real href for an IANA scheme (https)', () => {
        renderA({ href: 'https://example.com', children: 'link' })
        const link = document.querySelector('a')!
        expect(link.getAttribute('href')).toBe('https://example.com')
        expect(link).toHaveAttribute('data-hapi-external-link', 'true')
        expect(link).toHaveClass('text-[var(--app-markdown-link)]')
        expect(link.querySelector('[data-markdown-link-icon="external"]')).not.toBeNull()
    })

    it('does not navigate for a deny scheme (href="")', () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
        renderA({ href: '', children: 'evil' })
        fireEvent.click(document.querySelector('a')!)
        expect(openSpy).not.toHaveBeenCalled()
        openSpy.mockRestore()
    })
})

// ── relative / no-scheme hrefs — regression guard ────────────────────────────
//
// Finding 2: denyOnlyTransform passes relative hrefs through unchanged (no colon
// → not a scheme URL), but the <A> onClick handler called classifyScheme(href)
// which returned 'deny' for inputs with no valid scheme → preventDefault was
// called → relative/internal links were silently blocked.
//
// Fix: <A> must detect hrefs that have no scheme and treat them as 'iana' so the
// browser/router can navigate normally.

describe('markdown <A> component — relative / no-scheme hrefs navigate normally', () => {
    // Each of these hrefs has no URL scheme. Clicks must NOT be prevented.
    // We verify by checking that preventDefault is NOT called on the click event.

    function clickAndCheckNotPrevented(href: string) {
        renderA({ href, children: 'link' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).not.toHaveBeenCalled()
        cleanup()
    }

    it('/settings → click not prevented (absolute-path relative link)', () => {
        clickAndCheckNotPrevented('/settings')
    })

    it('does not mark an internal route as an external link', () => {
        renderA({ href: '/settings', children: 'settings' })

        const link = screen.getByRole('link')
        expect(link).not.toHaveAttribute('data-hapi-external-link')
        expect(link.querySelector('[data-markdown-link-icon="external"]')).toBeNull()
    })

    it('./foo → click not prevented (relative-path link)', () => {
        clickAndCheckNotPrevented('./foo')
    })

    it('#section → click not prevented (hash fragment link)', () => {
        clickAndCheckNotPrevented('#section')
    })

    it('?q=1 → click not prevented (query-only link)', () => {
        clickAndCheckNotPrevented('?q=1')
    })

    it('/path:colon → click not prevented (path with colon, no scheme)', () => {
        // "/" appears before ":" so this is a path, not a scheme.
        clickAndCheckNotPrevented('/path:colon')
    })

    it('//example.com → click not prevented (protocol-relative URL, no colon)', () => {
        // Protocol-relative URLs have no colon; browsers navigate them as the
        // current origin's protocol, same as any other relative href.
        clickAndCheckNotPrevented('//example.com/path')
    })

    it('https://example.com → click not prevented (regression: IANA still passes through)', () => {
        clickAndCheckNotPrevented('https://example.com')
    })

    it('C:/repo/file.ts → click not prevented (Windows drive path is not a custom scheme)', () => {
        clickAndCheckNotPrevented('C:/repo/file.ts')
    })

    it.each(['x://repo/file.ts', 'c://repo/file.ts'])('%s → stays on the custom-scheme confirmation path outside chat', (href) => {
        renderA({ href, children: 'custom link' })

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('href', '#')
        expect(link).not.toHaveClass('aui-md-file-link')
        expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
    })
})

describe('markdown <A> component — file path links', () => {
    it('routes explicit relative Markdown file hrefs through the session viewer', () => {
        renderAInChat({ href: 'docs/guide.md:42', children: 'guide' })

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveClass('text-[var(--app-markdown-link)]')
        expect(link).toHaveClass('bg-transparent', '[&_code]:bg-transparent')
        expect(link).not.toHaveClass('bg-[var(--app-inline-code-bg)]', 'hover:bg-[var(--app-code-copy-hover-bg)]')
        expect(link).toHaveAttribute('title', 'docs/guide.md:42')
        expect(link.querySelector('[data-markdown-link-icon="file"]')).not.toBeNull()

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64('docs/guide.md'),
                from: 'session',
                line: 42
            }
        })
    })

    it('routes authored relative hapi-file targets and preserves their coordinates', () => {
        const href = `hapi-file:${encodeURIComponent('web/src/router.tsx')}?line=42&column=7`

        renderAInChat({ href, children: 'web/src/router.tsx:42:7' })

        // File paths use the same inline text treatment as all message links.
        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link', 'message-content-link', 'no-underline')
        expect(link).not.toHaveClass('truncate', 'font-mono', 'border')
        expect(link.querySelector('[data-file-type="tsx"]')).not.toBeNull()
        expect(link).toHaveAttribute('title', 'web/src/router.tsx:42:7')

        const target = new URL(link.getAttribute('href')!, 'http://127.0.0.1')
        expect(target.pathname).toBe('/sessions/session-1/file')
        expect(target.searchParams.get('from')).toBe('session')
        expect(target.searchParams.get('line')).toBe('42')
        expect(target.searchParams.get('column')).toBe('7')

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64('web/src/router.tsx'),
                from: 'session',
                line: 42,
                column: 7
            }
        })
    })

    it.each(['a', 'go', 'Makefile'])('routes short or extensionless relative hapi-file target %s', (filePath) => {
        const href = `hapi-file:${encodeURIComponent(filePath)}`
        renderAInChat({ href, children: filePath })

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('data-hapi-file-link', 'true')

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                from: 'session'
            }
        })
    })

    it('routes a Windows-backslash relative hapi-file target with coordinates', () => {
        const filePath = 'src\\App.tsx'
        const href = `hapi-file:${encodeURIComponent(filePath)}?line=42&column=7`
        renderAInChat({ href, children: 'App.tsx:42:7' })

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('data-hapi-file-link', 'true')

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                from: 'session',
                line: 42,
                column: 7
            }
        })
    })

    it('routes encoded absolute project paths through the session file viewer', () => {
        const workspacePath = '/Users/alice/Projects/example-app'
        const filePath = `${workspacePath}/doc/中文 文件.md`
        const href = `${workspacePath}/doc/${encodeURIComponent('中文 文件.md')}:42:7`

        renderAInChat(
            { href, children: '中文 文件.md:42:7' },
            { workspacePath }
        )

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveAttribute('title', `${filePath}:42:7`)
        expect(link.nextElementSibling).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                from: 'session',
                line: 42,
                column: 7
            }
        })
    })

    it('routes Windows drive-root paths with a backslash workspace', () => {
        const workspacePath = 'C:\\Repo'
        const filePath = 'C:/repo/src/App.tsx'
        const href = `${filePath}:42:7`

        renderAInChat(
            { href, children: 'App.tsx:42:7' },
            { workspacePath }
        )

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveAttribute('title', `${filePath}:42:7`)

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                from: 'session',
                line: 42,
                column: 7
            }
        })
    })

    it.each(['x://repo/file.ts', 'c://repo/file.ts'])('%s is not a chat file link or copy target', (href) => {
        renderAInChat(
            { href, children: 'custom link' },
            { workspacePath: 'C:/repo' }
        )

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('href', '#')
        expect(link).not.toHaveClass('aui-md-file-link')
        expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
    })

    it('keeps external absolute paths unavailable but copyable, while HTTP(S) stays a web link', async () => {
        const workspacePath = '/Users/alice/Projects/example-app'
        const externalPath = '/Users/alice/Projects/other-project/doc/中文 文件.md'
        const externalHref = '/Users/alice/Projects/other-project/doc/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md'
        const writeText = vi.fn(async () => {})
        const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })

        try {
            renderAInChat(
                { href: externalHref, children: 'external file' },
                { workspacePath }
            )

            let link = screen.getByRole('link')
            expect(link).toHaveClass('aui-md-file-link')
            expect(link).toHaveAttribute('aria-disabled', 'true')
            expect(link).toHaveClass('message-content-link', 'bg-transparent', 'no-underline')
            expect(link.querySelector('[data-markdown-link-icon="disabled"]')).not.toBeNull()
            expect(link).not.toHaveAttribute('href')
            expect(link).not.toHaveAttribute('data-hapi-file-link')

            fireEvent.click(link)
            expect(routerMocks.navigate).not.toHaveBeenCalled()

            const copyButton = screen.getByRole('button', { name: 'Copy path' })
            fireEvent.click(copyButton)
            await waitFor(() => expect(writeText).toHaveBeenCalledWith(externalPath))

            cleanup()
            renderAInChat(
                { href: 'https://example.com/docs/README.md', children: 'web docs' },
                { workspacePath }
            )

            link = screen.getByRole('link')
            expect(link).not.toHaveClass('aui-md-file-link')
            expect(link).toHaveAttribute('href', 'https://example.com/docs/README.md')
            expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
        } finally {
            if (previousClipboard) {
                Object.defineProperty(navigator, 'clipboard', previousClipboard)
            } else {
                Reflect.deleteProperty(navigator, 'clipboard')
            }
        }
    })

    it('keeps external Windows drive paths unavailable', () => {
        renderAInChat(
            { href: 'C:/other-project/doc/README.md', children: 'external Windows file' },
            { workspacePath: 'C:/repo' }
        )

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveAttribute('aria-disabled', 'true')
        expect(link).not.toHaveAttribute('href')
        expect(link).not.toHaveAttribute('data-hapi-file-link')

        fireEvent.click(link)
        expect(routerMocks.navigate).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
    })

    it('keeps authored absolute hapi-file targets outside the workspace unavailable and copyable', async () => {
        const workspacePath = '/Users/alice/Projects/example-app'
        const filePath = '/Users/alice/Projects/other-project/doc/README.md'
        const writeText = vi.fn(async () => {})
        const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText }
        })

        try {
            const href = `hapi-file:${encodeURIComponent(filePath)}?line=42&column=7`
            renderAInChat({ href, children: 'external protocol file' }, { workspacePath })

            const link = screen.getByRole('link')
            expect(link).toHaveClass('aui-md-file-link')
            expect(link).toHaveAttribute('aria-disabled', 'true')
            expect(link).not.toHaveAttribute('href')
            expect(link).not.toHaveAttribute('data-hapi-file-link')

            fireEvent.click(link)
            expect(routerMocks.navigate).not.toHaveBeenCalled()

            const copyButton = screen.getByRole('button', { name: 'Copy path' })
            fireEvent.click(copyButton)
            await waitFor(() => expect(writeText).toHaveBeenCalledWith(filePath))
        } finally {
            if (previousClipboard) {
                Object.defineProperty(navigator, 'clipboard', previousClipboard)
            } else {
                Reflect.deleteProperty(navigator, 'clipboard')
            }
        }
    })

    it.each([
        ['/Users/alice/project/../other/README.md', '/Users/alice/project'],
        ['C:/repo/../other/README.md', 'C:/repo'],
        ['../other/README.md', '/Users/alice/project'],
    ])('keeps traversal target %s unavailable', (filePath, workspacePath) => {
        const href = `hapi-file:${encodeURIComponent(filePath)}`
        renderAInChat({ href, children: 'traversal file' }, { workspacePath })

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveAttribute('aria-disabled', 'true')
        expect(link).not.toHaveAttribute('href')
        expect(link).not.toHaveAttribute('data-hapi-file-link')

        fireEvent.click(link)
        expect(routerMocks.navigate).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
    })

    it.each(['vscode://file/secret', 'file:///secret'])('keeps authored protocol scheme target %s unavailable', (filePath) => {
        const href = `hapi-file:${encodeURIComponent(filePath)}`
        renderAInChat({ href, children: 'unsafe protocol target' })

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('aria-disabled', 'true')
        expect(link).not.toHaveAttribute('href')
        expect(link).not.toHaveAttribute('data-hapi-file-link')

        fireEvent.click(link)
        expect(routerMocks.navigate).not.toHaveBeenCalled()
    })

    it.each([
        ['/Users/alice/project/../other/README.md', '/Users/alice/project'],
        ['C:/repo/../other/README.md', 'C:/repo'],
    ])('keeps explicit traversal href %s unavailable', (href, workspacePath) => {
        renderAInChat({ href, children: 'traversal file' }, { workspacePath })

        const link = screen.getByRole('link')
        expect(link).toHaveClass('aui-md-file-link')
        expect(link).toHaveAttribute('aria-disabled', 'true')
        expect(link).not.toHaveAttribute('href')
        expect(link).not.toHaveAttribute('data-hapi-file-link')

        fireEvent.click(link)
        expect(routerMocks.navigate).not.toHaveBeenCalled()
        expect(screen.getByRole('button', { name: 'Copy path' })).toBeInTheDocument()
    })

    it('does not render a copy control for a navigable file path', () => {
        const filePath = '/Users/alice/Projects/example-app/doc/中文 文件.md'
        const href = `hapi-file:${encodeURIComponent(filePath)}?line=42`
        renderAInChat(
            { href, children: '中文 文件.md:42' },
            { workspacePath: '/Users/alice/Projects/example-app' }
        )

        const link = screen.getByRole('link')
        expect(link).toHaveAttribute('data-hapi-file-link', 'true')
        expect(link.nextElementSibling).toBeNull()
        expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
    })

    it('routes native Codex file paths through the owning runner', () => {
        const href = `hapi-file:${encodeURIComponent('web/src/router.tsx')}?line=42&column=7`
        renderAInChat(
            { href, children: 'web/src/router.tsx:42:7' },
            {
                fileLinkTarget: {
                    type: 'native-codex',
                    sessionId: 'codex-thread-1',
                    machineId: 'machine-1'
                }
            }
        )

        const link = screen.getByRole('link')
        const target = new URL(link.getAttribute('href')!, 'http://127.0.0.1')
        expect(target.pathname).toBe('/sessions/codex/codex-thread-1/file')
        expect(link).toHaveClass('bg-transparent', '[&_code]:bg-transparent')
        expect(link).not.toHaveClass('bg-[var(--app-inline-code-bg)]', 'hover:bg-[var(--app-code-copy-hover-bg)]')
        expect(target.searchParams.get('machineId')).toBe('machine-1')
        expect(target.searchParams.get('path')).toBe(encodeBase64('web/src/router.tsx'))
        expect(target.searchParams.get('line')).toBe('42')
        expect(target.searchParams.get('column')).toBe('7')

        fireEvent.click(link)
        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/codex/$codexSessionId/file',
            params: { codexSessionId: 'codex-thread-1' },
            search: {
                machineId: 'machine-1',
                path: encodeBase64('web/src/router.tsx'),
                line: 42,
                column: 7
            }
        })
    })
})

// ── intra-tab cross-provider sync (schemeListeners emitter) ──────────────────
//
// P7e.1 added a module-level `schemeListeners: Set<SchemeListener>` so that
// when two sibling <UriConfirmProvider>s exist in the same window (e.g.
// MarkdownText + Reasoning in AssistantMessage), clicking "Always allow" in
// one provider's dialog immediately updates the other without waiting for a
// cross-tab storage event (which browsers only fire in OTHER tabs).
//
// This test asserts that path: mount two sibling providers, trigger allow()
// in one via the dialog flow, verify the other's link href updates.

describe('intra-tab cross-provider sync (schemeListeners emitter)', () => {
    it('allowing a scheme in one UriConfirmProvider propagates to a sibling provider', async () => {
        localStorage.clear()

        // Suppress window.open — handleAlwaysAllow calls it after allow()
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

        render(
            <I18nProvider>
                <UriConfirmProvider>
                    <AnchorComponent href="obsidian://open?a=1">link1</AnchorComponent>
                </UriConfirmProvider>
                <UriConfirmProvider>
                    <AnchorComponent href="obsidian://open?a=2">link2</AnchorComponent>
                </UriConfirmProvider>
            </I18nProvider>
        )

        const links = screen.getAllByRole('link')
        const [a1, a2] = links

        // Both links start blocked (href="#") because obsidian is not yet allowed.
        expect(a1.getAttribute('href')).toBe('#')
        expect(a2.getAttribute('href')).toBe('#')

        // Click the first link → its provider opens the UriConfirmDialog.
        await act(async () => {
            fireEvent.click(a1)
        })

        // The "Always allow obsidian:" button is rendered by UriConfirmDialog
        // via Radix Dialog portal into document.body.
        const alwaysBtn = await waitFor(() =>
            screen.getByRole('button', { name: /always allow obsidian/i })
        )

        await act(async () => {
            fireEvent.click(alwaysBtn)
        })

        // After "Always allow", the schemeListeners emitter must have notified
        // the sibling provider synchronously. Both links should now carry the
        // live href (not '#').
        await waitFor(() => {
            expect(a1.getAttribute('href')).toBe('obsidian://open?a=1')
            expect(a2.getAttribute('href')).toBe('obsidian://open?a=2')
        })

        openSpy.mockRestore()
    })
})
