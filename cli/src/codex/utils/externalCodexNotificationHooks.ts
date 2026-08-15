import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { getHappyCliCommand } from '@/utils/spawnHappyCLI'

const EXTERNAL_CODEX_REQUEST_FLAG = '--external-codex-request'

type HookKind = 'permission' | 'user-input'

type InstallOptions = {
    hooksPath?: string
    runnerStatePath?: string
    commandForKind?: (kind: HookKind, runnerStatePath: string) => string
}

export type ExternalCodexNotificationHookInstallResult = {
    hooksPath: string
    addedKinds: HookKind[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function resolveCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim()
    const raw = configured?.replace(/^~(?=$|[\\/])/, homedir()) ?? join(homedir(), '.codex')
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

export function getExternalCodexNotificationHooksPath(): string {
    return join(resolveCodexHome(), 'hooks.json')
}

function shellQuote(value: string): string {
    if (value.length === 0) return '""'
    if (/^[A-Za-z0-9_\/:=-]+$/.test(value)) return value
    return `"${value.replace(/(["\\$`])/g, '\\$1')}"`
}

function shellJoin(parts: string[]): string {
    return parts.map(shellQuote).join(' ')
}

export function buildExternalCodexNotificationHookCommand(
    kind: HookKind,
    runnerStatePath: string = configuration.runnerStateFile
): string {
    const { command, args } = getHappyCliCommand([
        'hook-forwarder',
        EXTERNAL_CODEX_REQUEST_FLAG,
        '--kind',
        kind,
        '--runner-state',
        runnerStatePath
    ])
    return shellJoin([command, ...args])
}

function isOurHandler(value: unknown, kind: HookKind): boolean {
    const handler = asRecord(value)
    const command = typeof handler?.command === 'string' ? handler.command : ''
    return command.includes(EXTERNAL_CODEX_REQUEST_FLAG) && command.includes(`--kind ${kind}`)
}

function ensureEventHooks(
    hooks: Record<string, unknown>,
    eventName: 'PermissionRequest' | 'PreToolUse'
): Array<Record<string, unknown>> {
    const existing = hooks[eventName]
    if (existing === undefined) {
        const created: Array<Record<string, unknown>> = []
        hooks[eventName] = created
        return created
    }
    if (!Array.isArray(existing)) {
        throw new Error(`${eventName} in hooks.json must be an array; HAPI did not modify it`)
    }

    for (const entry of existing) {
        if (!asRecord(entry)) {
            throw new Error(`${eventName} in hooks.json contains an invalid hook group; HAPI did not modify it`)
        }
    }
    return existing as Array<Record<string, unknown>>
}

function hasHandler(groups: Array<Record<string, unknown>>, kind: HookKind): boolean {
    return groups.some((group) => {
        const handlers = group.hooks
        return Array.isArray(handlers) && handlers.some((handler) => isOurHandler(handler, kind))
    })
}

function buildHookGroup(kind: HookKind, command: string): Record<string, unknown> {
    return {
        matcher: kind === 'permission' ? '*' : '^request_user_input$',
        hooks: [{
            type: 'command',
            command,
            async: true,
            timeout: 10
        }]
    }
}

async function loadHooksJson(path: string): Promise<Record<string, unknown>> {
    try {
        const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown
        const root = asRecord(parsed)
        if (!root) {
            throw new Error('hooks.json must contain a JSON object')
        }
        return root
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Could not parse ${path}; HAPI did not modify it`)
        }
        const nodeError = error as NodeJS.ErrnoException
        if (nodeError.code === 'ENOENT') {
            return {}
        }
        throw error
    }
}

async function writeJsonAtomically(path: string, value: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 4)}\n`, 'utf-8')
    await rename(temporaryPath, path)
}

/**
 * Adds two additive, asynchronous user-level Codex hooks:
 * - PermissionRequest catches native approval prompts.
 * - PreToolUse catches the explicit request_user_input primitive.
 *
 * Both only signal the local runner and never approve, deny, or alter Codex.
 */
export async function installExternalCodexNotificationHooks(
    options: InstallOptions = {}
): Promise<ExternalCodexNotificationHookInstallResult> {
    const hooksPath = options.hooksPath ?? getExternalCodexNotificationHooksPath()
    const runnerStatePath = options.runnerStatePath ?? configuration.runnerStateFile
    const commandForKind = options.commandForKind ?? buildExternalCodexNotificationHookCommand
    const root = await loadHooksJson(hooksPath)

    const existingHooks = root.hooks
    let hooks: Record<string, unknown>
    if (existingHooks === undefined) {
        hooks = {}
        root.hooks = hooks
    } else {
        hooks = asRecord(existingHooks) ?? (() => {
            throw new Error('hooks in hooks.json must be an object; HAPI did not modify it')
        })()
    }

    const addedKinds: HookKind[] = []
    const permissionGroups = ensureEventHooks(hooks, 'PermissionRequest')
    if (!hasHandler(permissionGroups, 'permission')) {
        permissionGroups.push(buildHookGroup('permission', commandForKind('permission', runnerStatePath)))
        addedKinds.push('permission')
    }

    const userInputGroups = ensureEventHooks(hooks, 'PreToolUse')
    if (!hasHandler(userInputGroups, 'user-input')) {
        userInputGroups.push(buildHookGroup('user-input', commandForKind('user-input', runnerStatePath)))
        addedKinds.push('user-input')
    }

    if (addedKinds.length > 0) {
        await writeJsonAtomically(hooksPath, root)
    }

    return { hooksPath, addedKinds }
}
