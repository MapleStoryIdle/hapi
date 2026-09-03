import { configuration } from '@/configuration'

/** 包装后的 Agent 可用的当前 SHAPI Hub 会话 ID 环境变量。 */
export const HAPI_SESSION_ID_ENV = 'HAPI_SESSION_ID'

/**
 * 在 Hub 会话创建完成后把其 ID 传给下游 Agent 子进程。
 *
 * 一条 SHAPI CLI 进程只对应一个 Hub 会话，因此设置到当前进程环境即可让
 * Claude、Codex 和其他 Agent 的子进程继承；没有会话 ID 时保持环境不变。
 */
export function exportHapiSessionEnv(sessionId: string): void {
    if (sessionId) {
        process.env[HAPI_SESSION_ID_ENV] = sessionId
    }
}

/**
 * 将显式配置的 Hub 地址传给 Agent 子进程。
 *
 * 不能导出隐式 localhost 默认值，否则 `maybeAutoStartServer` 会误以为
 * 用户指定了远端 Hub，进而跳过本地自动启动。
 */
export function exportHapiHubApiUrl(options: { exportApiUrl?: boolean } = {}): void {
    if (!options.exportApiUrl) return
    const apiUrl = configuration.apiUrl.trim()
    if (apiUrl) {
        process.env.HAPI_API_URL = apiUrl
    }
}
