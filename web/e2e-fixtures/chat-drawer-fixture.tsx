import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { ChatDetailDialog } from '../src/components/ui/ChatDetailDialog'
import { SessionDetailSurface } from '../src/components/SessionDetailSurface'
import { useChatPreview } from '../src/components/ChatPreviewContext'
import { I18nProvider } from '../src/lib/i18n-context'
import { QuestionAnswerForm } from '../src/components/ToolCard/QuestionAnswerForm'
import { TerminalExecutionDrawer } from '../src/components/ToolCard/TerminalExecutionDrawer'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { QuestionAnswerBubble } from '../src/components/AssistantChat/messages/QuestionAnswerBubble'
import { ImagePreview } from '../src/components/ImagePreview'
import { EditView } from '../src/components/ToolCard/views/EditView'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import type { ApiClient } from '../src/api/client'
import { localServiceLaunchHref } from '../src/lib/local-service-links'

const reviewStartedAt = Date.now() - 45_000

const api = {
    readCodexSessionFile: async () => ({ success: false, error: new URLSearchParams(location.search).get('file-error') || 'ENOENT: no such file /private/example.png' }),
    openLocalService: async () => ({ url: location.origin + '/__shapi_local/embed/' + 'b'.repeat(64) + '/local-app', expiresAt: Date.now() + 60_000 }),
    readSessionFile: async () => ({ success: true, content: btoa(Array.from({ length: 100 }, (_, i) => `const line${i + 1} = "hello"`).join('\n')) }),
    getGitDiffFile: async () => ({ success: true, stdout: '+added line\n-removed line' })
} as unknown as ApiClient

function Content() {
    const preview = useChatPreview()
    const [question, setQuestion] = useState(false)
    const [terminal, setTerminal] = useState(false)
    const [terminalLines, setTerminalLines] = useState(100)
    useEffect(() => {
        const update = (event: Event) => setTerminalLines((event as CustomEvent<number>).detail)
        window.addEventListener('fixture-terminal-lines', update)
        return () => window.removeEventListener('fixture-terminal-lines', update)
    }, [])
    const [sent, setSent] = useState(0)
    return <>
        <header className="p-5 text-lg font-semibold">SHAPI · Chat drawer test</header>
        <main className="flex-1 space-y-4 overflow-auto p-5">
            <p>Details stay here. Your conversation does not go away.</p>
            <ChatDetailDialog title="Short detail" subtitle="A little more detail" trigger={<button className="block rounded-xl border p-3">Short detail</button>}>
                <p>Just one line.</p>
            </ChatDetailDialog>
            <ChatDetailDialog title="Long detail" trigger={<button className="block rounded-xl border p-3">Long detail</button>}>
                {Array.from({ length: 100 }, (_, i) => <p className="py-2" key={i}>Log line {i + 1}: completed successfully.</p>)}
            </ChatDetailDialog>
            <ChatDetailDialog title="Long edit" trigger={<button className="block rounded-xl border p-3">Long edit</button>}>
                <EditView metadata={null} surface="dialog" block={{
                    kind: 'tool-call', id: 'edit', localId: null, createdAt: 100, children: [],
                    tool: { id: 'edit', name: 'Edit', state: 'completed', input: { file_path: 'large.ts', old_string: '', new_string: Array.from({ length: 200 }, (_, i) => `updated line ${i + 1}`).join('\n') }, result: 'OK', createdAt: 100, startedAt: 100, completedAt: 200, description: null }
                }} />
            </ChatDetailDialog>
            <button className="block rounded-xl border p-3" onClick={() => setTerminal(true)}>Terminal detail</button>
            <TerminalExecutionDrawer open={terminal} onOpenChange={setTerminal} block={{
                kind: 'tool-call', id: 'terminal', localId: null, createdAt: 100, children: [],
                tool: { id: 'terminal', name: 'CodexBash', state: 'completed', input: { command: new URLSearchParams(location.search).has('long-command') ? 'cat /workspace/' + 'long-folder/'.repeat(20) + 'build.log' : 'bun run test:web', cwd: '/workspace/hapi' },
                    result: { stdout: Array.from({length: terminalLines}, (_, i) => `Test ${i + 1} passed`).join('\n'), exit_code: 0 },
                    createdAt: 100, startedAt: 200, completedAt: 2450, description: null }
            }} />
            <button className="block rounded-xl border p-3" onClick={() => preview?.({ type: 'file', api, source: { type: 'session', sessionId: 'fixture' }, workspacePath: '/workspace/hapi', path: 'src/example.ts', line: 80 })}>File preview</button>
            <button className="block rounded-xl border p-3" onClick={() => preview?.({ type: 'file', api, source: { type: 'native-codex', machineId: 'fixture-machine', sessionId: 'fixture' }, path: 'example.ts' })}>Unavailable file preview</button>
            <button className="block rounded-xl border p-3" onClick={() => preview?.({ type: 'url', url: 'https://example.com/' })}>Web preview</button>
            <MarkdownRenderer standalone content="[Content web link](/content/article)" />
            <button className="block rounded-xl border p-3" onClick={() => preview?.({ type: 'url', url: localServiceLaunchHref('http://localhost:3000/', { type: 'session', sessionId: 'fixture' })!, localService: { api, request: { source: { type: 'session', sessionId: 'fixture' }, url: 'http://localhost:3000/' } } })}>Local service preview</button>
            <button className="block rounded-xl border p-3" onClick={() => setQuestion(true)}>Choose options</button>
            {question ? <QuestionAnswerForm questions={[{ id: 'colors', header: 'Preferences', question: 'Pick colors', multiSelect: true, options: [
                { value: 'blue', label: 'Blue', description: 'The color of the sky' }, { value: 'green', label: 'Green', description: 'The color of leaves' }
            ] }]} disabled={false} onSubmit={async () => { setSent((n) => n + 1); await new Promise((resolve) => setTimeout(resolve, 500)) }} onDone={() => setQuestion(false)} textPlaceholder="Type your answer" /> : null}
            <QuestionAnswerBubble answer={{ items: [{
                question: 'Which app should open the note?', answers: ['Notes'],
                options: [
                    { label: 'Notes', description: '[Open note](obsidian://open?vault=fixture)', selected: true },
                    { label: 'Browser', description: 'Keep reading on the web', selected: false }
                ]
            }] }} />
            <ChatDetailDialog title="Linked details" testId="linked-details-drawer" trigger={<button className="block rounded-xl border p-3">Linked details</button>}>
                <MarkdownRenderer standalone content="[Open note](obsidian://open?vault=fixture)" />
                <button className="min-h-11" onClick={() => preview?.({ type: 'file', api, source: { type: 'session', sessionId: 'fixture' }, workspacePath: '/workspace/hapi', path: 'src/example.ts' })}>Nested file</button>
            </ChatDetailDialog>
            <ImagePreview src={'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#406f99"/><circle cx="300" cy="200" r="100" fill="#eef2f7"/></svg>')}
                fileName="sample.svg" label="Example image" buttonClassName="block w-40 rounded-xl border p-2" />
            <output data-testid="sent-count">{sent}</output>
            <ToolCard api={api} sessionId="fixture" metadata={null} terminalToolDisplayMode="compact" disabled={false} onDone={() => {}} block={{
                kind: 'tool-call', id: 'subagent-review', localId: null, createdAt: 100,
                children: Array.from({ length: 18 }, (_, i) => ({
                    kind: 'agent-text', id: `review-line-${i}`, localId: null, createdAt: 100 + i,
                    text: `Review step ${i + 1}: checked keyboard focus and scrolling. No layout shift found.`
                })),
                tool: { id: 'subagent-review', name: 'CodexAgent', state: 'running',
                    input: { summary: 'Drawer review', activity: 'Checking mobile drawer interactions', agent_type: 'reviewer',
                        model: 'test-model', reasoning_effort: 'high', agentId: 'review-agent-identifier',
                        prompt: 'Review the drawer height, drag gestures, keyboard focus, and light/dark theme contrast.' },
                    createdAt: reviewStartedAt, startedAt: reviewStartedAt, completedAt: null, description: null }
            }} />
        </main>
        <footer data-testid="composer" className="shrink-0 border-t bg-[var(--app-bg)] p-4">
            <div className="rounded-2xl border p-4">Message SHAPI…</div>
        </footer>
    </>
}
ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <I18nProvider><SessionDetailSurface source="hapi"><Content /></SessionDetailSurface></I18nProvider>
    </QueryClientProvider>
)
