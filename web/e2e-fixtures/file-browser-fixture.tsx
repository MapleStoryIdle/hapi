import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiClient } from '../src/api/client'
import { SessionFilesDrawer } from '../src/components/SessionFiles/SessionFilesDrawer'
import { DirectoryPickerDrawer } from '../src/components/DirectoryPickerDrawer'
import { I18nProvider } from '../src/lib/i18n-context'
import type { SessionFileBrowserRequest, SessionFileBrowserResponse } from '@hapi/protocol/apiTypes'
import type { Machine } from '../src/types/api'
import '../src/index.css'

const entries = [
    { name: 'components', type: 'directory' as const }, { name: 'hooks', type: 'directory' as const }, { name: 'routes', type: 'directory' as const },
    { name: 'README.md', type: 'file' as const, size: 4200 }, { name: 'index.ts', type: 'file' as const, size: 2800 }, { name: 'preview.png', type: 'file' as const, size: 128000 }
]
class FixtureApi extends ApiClient {
    async browseCodexSessionFiles(_id: string, _machineId: string, request: SessionFileBrowserRequest): Promise<SessionFileBrowserResponse> {
        if (request.action === 'changes') return { success: true, isGitRepository: true, status: '# branch.head feature/files\n? README.md\n? index.ts\n? preview.png\n', unstaged: '', staged: '' }
        if (request.action === 'diff') return { success: true, stdout: '' }
        return { success: true, entries }
    }
    async readCodexSessionFile() { return { success: true, content: btoa('# Project files\n\nPreview stays inside this sheet.') } }
    async listMachineDirectory() { return { success: true, entries } }
}
const api = new FixtureApi('fixture-no-network')
const machines = [{ id: 'fixture', active: true, metadata: { host: 'Mac', displayName: 'Mac', workspaceRoots: ['/workspace/hapi'], platform: 'darwin' } }] as Machine[]
function Fixture() {
    const [open, setOpen] = useState(true)
    const [picker, setPicker] = useState(false)
    const [selected, setSelected] = useState('')
    return <main className="min-h-dvh bg-[var(--app-bg)] p-5" data-drawer-page-background><h1 className="text-2xl font-semibold">SHAPI</h1><p className="mt-5">可以在这里浏览项目文件。</p>
        <button className="m-3 min-h-11 text-blue-600" onClick={() => setOpen(true)}>Files</button>
        <button className="m-3 min-h-11 text-blue-600" onClick={() => setPicker(true)}>Choose directory</button><output>{selected}</output>
        <SessionFilesDrawer api={api} source={{ type: 'native-codex', sessionId: 'fixture', machineId: 'fixture' }} cwd="/workspace/hapi" open={open} onOpenChange={setOpen} />
        <DirectoryPickerDrawer api={api} machines={machines} machinesLoading={false} initialMachineId="fixture" open={picker} onOpenChange={setPicker} onSelect={(_, path) => setSelected(path)} />
    </main>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient()}><I18nProvider><Fixture /></I18nProvider></QueryClientProvider>)
