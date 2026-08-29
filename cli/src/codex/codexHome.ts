import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

function resolveLocalPath(pathValue: string): string {
    return isAbsolute(pathValue) ? pathValue : resolve(process.cwd(), pathValue)
}

export function getCodexHomePath(): string {
    const configured = process.env.CODEX_HOME?.trim()
    if (!configured) return resolve(homedir(), '.codex')
    return resolveLocalPath(configured.replace(/^~(?=$|[\\/])/, homedir()))
}
