import { afterEach, describe, expect, it, vi } from 'vitest'

const { configuration } = vi.hoisted(() => ({
    configuration: {
        apiUrl: 'https://hub.example.test'
    }
}))

vi.mock('@/configuration', () => ({ configuration }))

import { HAPI_SESSION_ID_ENV, exportHapiHubApiUrl, exportHapiSessionEnv } from './hapiSessionEnv'

describe('hapiSessionEnv', () => {
    const originalSessionId = process.env.HAPI_SESSION_ID
    const originalApiUrl = process.env.HAPI_API_URL

    afterEach(() => {
        if (originalSessionId === undefined) delete process.env.HAPI_SESSION_ID
        else process.env.HAPI_SESSION_ID = originalSessionId
        if (originalApiUrl === undefined) delete process.env.HAPI_API_URL
        else process.env.HAPI_API_URL = originalApiUrl
    })

    it('会把已物化的 Hub 会话 ID 暴露给 Agent 子进程', () => {
        exportHapiSessionEnv('session-123')
        expect(process.env[HAPI_SESSION_ID_ENV]).toBe('session-123')
    })

    it('仅在 Hub 地址显式配置时导出地址', () => {
        delete process.env.HAPI_API_URL
        exportHapiHubApiUrl()
        expect(process.env.HAPI_API_URL).toBeUndefined()

        exportHapiHubApiUrl({ exportApiUrl: true })
        expect(process.env.HAPI_API_URL).toBe('https://hub.example.test')
    })
})
