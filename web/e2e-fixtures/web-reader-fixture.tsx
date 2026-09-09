import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '../src/api/client'
import { AppContextProvider } from '../src/lib/app-context'
import { I18nProvider } from '../src/lib/i18n-context'
import ChatPreviewDrawer from '../src/components/ChatPreviewDrawer'
import type { WebReaderResponse } from '@hapi/protocol/webReader'
import '../src/index.css'

class FixtureApi extends ApiClient {
    async readWebPage(): Promise<WebReaderResponse> {
        return { mode: 'readonly', title: 'X-Frame-Options header · MDN', url: 'https://example.com/', content: [
            { tag: 'h1', children: ['X-Frame-Options'] },
            { tag: 'p', children: ['这是只读预览示例。网站不允许内嵌时，直接展示正文和代码，不运行原网页的脚本。'] },
            { tag: 'h2', children: ['Syntax'] },
            { tag: 'pre', children: [{ tag: 'code', children: ['X-Frame-Options: DENY\nX-Frame-Options: SAMEORIGIN'] }] },
            ...Array.from({ length: 10 }, () => ({ tag: 'p' as const, children: ['上下滑动阅读正文；拖动顶部把手可以展开抽屉。关闭按钮始终保留。'] }))
        ] }
    }
}
const api = new FixtureApi('fixture-no-network')
function Fixture() {
    const [open, setOpen] = useState(true)
    return <main data-drawer-page-background className="min-h-dvh p-5"><h1>SHAPI</h1><button onClick={() => setOpen(true)}>Preview</button>
        <ChatPreviewDrawer preview={{ type: 'url', url: 'https://example.com/' }} open={open} onOpenChange={setOpen} />
    </main>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><I18nProvider><AppContextProvider value={{ api, token: 'fixture', baseUrl: '' }}><Fixture /></AppContextProvider></I18nProvider></QueryClientProvider>)
