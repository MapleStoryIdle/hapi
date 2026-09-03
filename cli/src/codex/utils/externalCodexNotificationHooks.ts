import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { configuration } from '@/configuration'
import { getHappyCliCommand } from '@/utils/spawnHappyCLI'

const EXTERNAL_CODEX_REQUEST_FLAG = '--external-codex-request'
const EXTERNAL_CODEX_LIFECYCLE_FLAG = '--external-codex-lifecycle'

type HookKind = 'permission' | 'user-input' | 'user-input-resolved' | 'turn-started'

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
    const lifecycle = kind === 'turn-started'
    const userInputResolved = kind === 'user-input-resolved'
    const { command, args } = getHappyCliCommand([
        'hook-forwarder',
        lifecycle ? EXTERNAL_CODEX_LIFECYCLE_FLAG : EXTERNAL_CODEX_REQUEST_FLAG,
        ...(lifecycle ? [] : ['--kind', userInputResolved ? 'user-input' : kind]),
        ...(userInputResolved ? ['--phase', 'resolved'] : []),
        '--runner-state',
        runnerStatePath
    ])
    return shellJoin([command, ...args])
}

function isOurHandler(value: unknown, kind: HookKind): boolean {
    const handler = asRecord(value)
    const command = typeof handler?.command === 'string' ? handler.command : ''
    if (kind === 'turn-started') return command.includes(EXTERNAL_CODEX_LIFECYCLE_FLAG)
    if (kind === 'user-input-resolved') {
        return command.includes(EXTERNAL_CODEX_REQUEST_FLAG)
            && command.includes('--kind user-input')
            && command.includes('--phase resolved')
    }
    return command.includes(EXTERNAL_CODEX_REQUEST_FLAG)
        && command.includes(`--kind ${kind}`)
        && !command.includes('--phase resolved')
}

function ensureEventHooks(
    hooks: Record<string, unknown>,
    eventName: 'PermissionRequest' | 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit'
): Array<Record<string, unknown>> {
    const existing = hooks[eventName]
    if (existing === undefined) {
        const created: Array<Record<string, unknown>> = []
        hooks[eventName] = created
        return created
    }
    if (!Array.isArray(existing)) {
        throw new Error(`${eventName} in hooks.json must be an array; SHAPI did not modify it`)
    }

    for (const entry of existing) {
        if (!asRecord(entry)) {
            throw new Error(`${eventName} in hooks.json contains an invalid hook group; SHAPI did not modify it`)
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

function removeUnsupportedAsyncFlags(groups: Array<Record<string, unknown>>, kind: HookKind): boolean {
    let changed = false
    for (const group of groups) {
        const handlers = group.hooks
        if (!Array.isArray(handlers)) continue

        for (const handler of handlers) {
            if (!isOurHandler(handler, kind)) continue
            const hook = asRecord(handler)
            if (hook?.async === true) {
                delete hook.async
                changed = true
            }
        }
    }
    return changed
}

function buildHookGroup(kind: HookKind, command: string): Record<string, unknown> {
    if (kind === 'turn-started') {
        // UserPromptSubmit has no useful matcher: Codex ignores it there.
        return {
            hooks: [{
                type: 'command',
                command,
                timeout: 10
            }]
        }
    }
    return {
        matcher: kind === 'permission' ? '*' : '^request_user_input$',
        hooks: [{
            type: 'command',
            command,
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
            throw new Error(`Could not parse ${path}; SHAPI did not modify it`)
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
 * Adds four additive user-level Codex hooks:
 * - PermissionRequest catches native approval prompts.
 * - PreToolUse catches the explicit request_user_input primitive.
 * - PostToolUse clears that local-input state once Codex receives the answer.
 * - UserPromptSubmit marks a native turn as locally processing.
 *
 * All only signal the local runner and never approve, deny, or alter Codex.
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
            throw new Error('hooks in hooks.json must be an object; SHAPI did not modify it')
        })()
    }

    const addedKinds: HookKind[] = []
    const permissionGroups = ensureEventHooks(hooks, 'PermissionRequest')
    const migratedPermissionHook = removeUnsupportedAsyncFlags(permissionGroups, 'permission')
    if (!hasHandler(permissionGroups, 'permission')) {
        permissionGroups.push(buildHookGroup('permission', commandForKind('permission', runnerStatePath)))
        addedKinds.push('permission')
    }

    const userInputGroups = ensureEventHooks(hooks, 'PreToolUse')
    const migratedUserInputHook = removeUnsupportedAsyncFlags(userInputGroups, 'user-input')
    if (!hasHandler(userInputGroups, 'user-input')) {
        userInputGroups.push(buildHookGroup('user-input', commandForKind('user-input', runnerStatePath)))
        addedKinds.push('user-input')
    }

    const userInputResolvedGroups = ensureEventHooks(hooks, 'PostToolUse')
    const migratedUserInputResolvedHook = removeUnsupportedAsyncFlags(userInputResolvedGroups, 'user-input-resolved')
    if (!hasHandler(userInputResolvedGroups, 'user-input-resolved')) {
        userInputResolvedGroups.push(buildHookGroup(
            'user-input-resolved',
            commandForKind('user-input-resolved', runnerStatePath)
        ))
        addedKinds.push('user-input-resolved')
    }

    const turnStartGroups = ensureEventHooks(hooks, 'UserPromptSubmit')
    const migratedTurnStartHook = removeUnsupportedAsyncFlags(turnStartGroups, 'turn-started')
    if (!hasHandler(turnStartGroups, 'turn-started')) {
        turnStartGroups.push(buildHookGroup('turn-started', commandForKind('turn-started', runnerStatePath)))
        addedKinds.push('turn-started')
    }

    if (
        addedKinds.length > 0
        || migratedPermissionHook
        || migratedUserInputHook
        || migratedUserInputResolvedHook
        || migratedTurnStartHook
    ) {
        await writeJsonAtomically(hooksPath, root)
    }

    return { hooksPath, addedKinds }
}
