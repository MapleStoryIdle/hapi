import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import type { Session, SyncEngine } from '../../sync/syncEngine'
import type { WebAppEnv } from '../middleware/auth'
import { createGitRoutes } from './git'

function buildApp(engine: Partial<SyncEngine>): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', 'default')
        await next()
    })
    app.route('/api', createGitRoutes(() => engine as SyncEngine))
    return app
}

describe('git branch route', () => {
    it('uses the runner-scoped directory RPC for a historical session group', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: false,
            metadata: { path: '/work/project', machineId: 'machine-1' }
        } as unknown as Session
        let machineCalls = 0
        let sessionCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            getMachine: () => ({ id: 'machine-1', namespace: 'default' }),
            getMachineGitBranch: async (machineId: string, cwd: string) => {
                machineCalls += 1
                expect(machineId).toBe('machine-1')
                expect(cwd).toBe('/work/project')
                return {
                    success: true,
                    stdout: '# branch.oid abc123\n# branch.head feature/list-branch\n',
                    stderr: '',
                    exitCode: 0
                }
            },
            getGitStatus: async () => {
                sessionCalls += 1
                return { success: false, error: 'inactive session' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/git-branch')

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true })
        expect(machineCalls).toBe(1)
        expect(sessionCalls).toBe(0)
    })

    it('keeps the full status endpoint session-scoped for the Files view', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/work/project', machineId: 'machine-1' }
        } as unknown as Session
        let machineCalls = 0
        let sessionCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            getMachine: () => ({ id: 'machine-1', namespace: 'default' }),
            getMachineGitBranch: async () => {
                machineCalls += 1
                return { success: true, stdout: '', stderr: '', exitCode: 0 }
            },
            getGitStatus: async (sessionId: string, cwd: string) => {
                sessionCalls += 1
                expect(sessionId).toBe('session-1')
                expect(cwd).toBe('/work/project')
                return { success: true, stdout: '# branch.head main\n? new-file\n', stderr: '', exitCode: 0 }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/git-status')

        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ success: true })
        expect(sessionCalls).toBe(1)
        expect(machineCalls).toBe(0)
    })
})

describe('session file route', () => {
    it('uses the runner-scoped file RPC for a completed HAPI session', async () => {
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: false,
            metadata: { path: '/work/project', machineId: 'machine-1' }
        } as unknown as Session
        let machineCalls = 0
        let sessionCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            getMachine: () => ({ id: 'machine-1', namespace: 'default' }),
            readMachineFile: async (machineId: string, cwd: string, path: string) => {
                machineCalls += 1
                expect(machineId).toBe('machine-1')
                expect(cwd).toBe('/work/project')
                expect(path).toBe('src/example.ts')
                return { success: true, content: 'ZXhwb3J0IGNvbnN0IGZpbGUgPSB0cnVlCg==' }
            },
            readSessionFile: async () => {
                sessionCalls += 1
                return { success: false, error: 'inactive session' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file?path=src%2Fexample.ts')

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            success: true,
            content: 'ZXhwb3J0IGNvbnN0IGZpbGUgPSB0cnVlCg=='
        })
        expect(machineCalls).toBe(1)
        expect(sessionCalls).toBe(0)
    })
})

describe('generated images route', () => {
    it('serves generated images with an immutable cache header instead of no-store', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImageBytes: async () => ({
                success: true,
                bytes: pngBytes,
                mimeType: 'image/png',
                fileName: 'shot.png'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1')

        expect(response.status).toBe(200)
        const cacheControl = response.headers.get('cache-control') ?? ''
        // Browser caching stays enabled; `no-store` forces a full RPC round-trip on every remount.
        expect(cacheControl).toContain('immutable')
        expect(cacheControl).not.toContain('no-store')
        expect(response.headers.get('etag')).toBe('"img-1"')
    })

    it('returns 304 without an RPC round-trip when If-None-Match matches', async () => {
        const session = { id: 'session-1', namespace: 'default', active: true } as unknown as Session
        let rpcCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readGeneratedImageBytes: async () => {
                rpcCalls += 1
                return { success: true, bytes: new Uint8Array(), mimeType: 'image/png', fileName: 'shot.png' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/generated-images/img-1', {
            headers: { 'if-none-match': '"img-1"' }
        })

        expect(response.status).toBe(304)
        // The whole point: a cache hit must not touch the CLI over the socket.
        expect(rpcCalls).toBe(0)
    })
})

describe('session file blob route', () => {
    it('serves image file bytes without wrapping content in base64 JSON', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: true,
            metadata: { path: '/tmp/project' }
        } as unknown as Session
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            readSessionFileBytes: async (_sessionId: string, path: string) => ({
                success: true,
                bytes: pngBytes,
                mimeType: 'image/png',
                fileName: path.split('/').pop() ?? 'file'
            })
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file-blob?path=images/shot.png')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('image/png')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(pngBytes))
    })

    it('uses the runner-scoped byte reader for a completed HAPI session', async () => {
        const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const session = {
            id: 'session-1',
            namespace: 'default',
            active: false,
            metadata: { path: '/work/project', machineId: 'machine-1' }
        } as unknown as Session
        let machineCalls = 0
        let sessionCalls = 0
        const engine = {
            resolveSessionAccess: () => ({ ok: true as const, sessionId: 'session-1', session }),
            getMachine: () => ({ id: 'machine-1', namespace: 'default' }),
            readMachineFileBytes: async (machineId: string, cwd: string, path: string) => {
                machineCalls += 1
                expect(machineId).toBe('machine-1')
                expect(cwd).toBe('/work/project')
                expect(path).toBe('images/shot.png')
                return {
                    success: true,
                    bytes: pngBytes,
                    mimeType: 'image/png',
                    fileName: 'shot.png'
                }
            },
            readSessionFileBytes: async () => {
                sessionCalls += 1
                return { success: false, error: 'inactive session' }
            }
        } as unknown as Partial<SyncEngine>

        const response = await buildApp(engine).request('/api/sessions/session-1/file-blob?path=images%2Fshot.png')

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('image/png')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(pngBytes))
        expect(machineCalls).toBe(1)
        expect(sessionCalls).toBe(0)
    })
})
