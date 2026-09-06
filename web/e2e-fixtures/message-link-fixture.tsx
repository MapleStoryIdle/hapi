import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { HappyChatProvider } from '../src/components/AssistantChat/context'
import type { ApiClient } from '../src/api/client'
import { I18nProvider } from '../src/lib/i18n-context'

const cases = [
    '[Docs](https://example.com)',
    '[README.md](https://example.com/README.md)',
    '[**中文文档**](https://example.com/guide)',
    '[`src/components/VeryLongFileNameThatMustWrapOnNarrowPhones.tsx`](https://example.com/file.tsx)',
    '[https://example.com/a/very/long/path/that/does/not/fit/on/a/phone/without/wrapping](https://example.com/long)'
]
ReactDOM.createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <main style={{ width: '100%', maxWidth: 320, padding: 16 }}>
            {cases.map((content, index) => (
                <div key={content} data-testid={`link-case-${index}`} style={{ width: '100%', marginBottom: 20 }}>
                    <MarkdownRenderer standalone content={`Before ${content} after.`} />
                </div>
            ))}
            {new URLSearchParams(location.search).has('unavailable') ? <HappyChatProvider value={{
                api: {} as ApiClient, sessionId: 'fixture', metadata: { path: '/workspace/hapi', host: 'local' },
                terminalToolDisplayMode: 'compact', disabled: false, onRefresh: () => {},
                hasMoreMessages: false, isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => false,
            }}><div data-testid="unavailable-file"><MarkdownRenderer standalone content="[private.ts](/outside/private.ts)" /></div></HappyChatProvider> : null}
        </main>
    </I18nProvider>
)
