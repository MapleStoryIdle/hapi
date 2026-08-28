import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

function getCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    if (!configured) return join(homedir(), '.codex')
    return resolveLocalPath(configured.replace(/^~(?=$|[\\/])/, homedir()))
}

/**
 * Returns whether Codex's long-lived app-server control endpoint is present.
 * The endpoint owns the thread writer lock; callers should use `codex queue`
 * instead of starting a second `codex exec resume` writer when it is present.
 */
export function hasCodexAppServerControlSocket(): boolean {
    const socketPath = join(getCodexHome(), 'app-server-control', 'app-server-control.sock')
    try {
        if (!existsSync(socketPath)) return false
        // Windows named pipes may be visible to `existsSync` but do not expose
        // a Unix-style `Stats.isSocket()` result.
        if (process.platform === 'win32') return true
        const stat = statSync(socketPath)
        return stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice()
    } catch {
        // Named pipes on Windows are not always stat-able through Node. Let
        // the Codex CLI make the final connection decision there.
        return existsSync(socketPath)
    }
}
