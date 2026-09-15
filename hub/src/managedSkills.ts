import {
    ManagedSkillReconcileResponseSchema,
    type Machine,
    type ManagedSkillCatalogEntry,
    type ManagedSkillDefinition,
    type ManagedSkillMachineState,
    type ManagedSkillPayload
} from '@hapi/protocol'
import type { SyncEngine } from './sync/syncEngine'
import { MANAGED_SKILL_LIBRARY } from './managedSkillCatalog'
import { managedSkillDigest } from './managedSkillBundles'
import type { Store } from './store'

const SETTINGS_PREFIX = 'managed-skill:'

type SkillScope = 'hub' | 'project' | 'user' | 'plugin' | 'system' | 'admin'
type SkillSummary = {
    name: string
    description?: string
    descriptions?: Partial<Record<'en' | 'zh-CN', string>>
    scope?: SkillScope
}
type RequiredScopeSkillSummary = SkillSummary & { scope: SkillScope }

export function isManagedSkillEnabled(store: Store, namespace: string, id: string): boolean {
    return store.pluginSettings.isEnabled(namespace, `${SETTINGS_PREFIX}${id}`)
}

export function setManagedSkillEnabled(store: Store, namespace: string, id: string, enabled: boolean): void {
    store.pluginSettings.setEnabled(namespace, `${SETTINGS_PREFIX}${id}`, enabled)
}

function library(store?: Store, namespace?: string): readonly ManagedSkillDefinition[] {
    return store?.managedSkillPackages.listActive(namespace).map((item) => item.definition) ?? MANAGED_SKILL_LIBRARY
}

function compareVersions(left: string, right: string): number {
    const a = left.split('.').map(Number)
    const b = right.split('.').map(Number)
    for (let index = 0; index < 3; index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0)
        if (difference !== 0) return difference
    }
    return 0
}

export function managedSkillCatalog(store?: Store, namespace?: string): ManagedSkillCatalogEntry[] {
    if (store) {
        return store.managedSkillPackages.listActive(namespace).map(({ definition, visibility }) => {
            const { files, ...skill } = definition
            return { ...skill, sha256: managedSkillDigest(files), visibility }
        })
    }
    return MANAGED_SKILL_LIBRARY.map(({ files, ...skill }) => ({
        ...skill,
        sha256: managedSkillDigest(files),
        visibility: 'public'
    }))
}

/** Enabled Hub Skills replace a same-named Runner Skill; disabled Hub Skills do not hide local Skills. */
export function mergeEnabledManagedSkills(
    runnerSkills: readonly RequiredScopeSkillSummary[],
    store: Store | undefined,
    namespace: string
): RequiredScopeSkillSummary[]
export function mergeEnabledManagedSkills(
    runnerSkills: readonly SkillSummary[],
    store: Store | undefined,
    namespace: string
): SkillSummary[]
export function mergeEnabledManagedSkills(
    runnerSkills: readonly SkillSummary[],
    store: Store | undefined,
    namespace: string
): SkillSummary[] {
    const enabled = managedSkillCatalog(store, namespace)
        .filter((skill) => !store || isManagedSkillEnabled(store, namespace, skill.id))
    const enabledIds = new Set(enabled.map((skill) => skill.id))
    return [
        ...runnerSkills.filter((skill) => !enabledIds.has(skill.name)),
        ...enabled.map((skill) => ({
            name: skill.id,
            description: skill.description,
            descriptions: skill.descriptions,
            scope: 'hub' as const
        }))
    ]
}

export function findManagedSkillInvocation(text: string | undefined, store?: Store, namespace?: string): string | null {
    const id = text?.match(/^\$([a-z][a-z0-9-]{0,63})(?:\s+|$)/)?.[1]
    return id && library(store, namespace).some((skill) => skill.id === id) ? id : null
}

function payloadFor(id: string, store?: Store, namespace?: string): ManagedSkillPayload | null {
    const definition = store?.managedSkillPackages.getActive(id, namespace)
        ?? MANAGED_SKILL_LIBRARY.find((skill) => skill.id === id)
    if (!definition) return null
    return {
        id: definition.id,
        version: definition.version,
        sha256: managedSkillDigest(definition.files),
        files: definition.files
    }
}

export async function ensureManagedSkillCached(engine: SyncEngine, machine: Machine, id: string, store?: Store, namespace?: string): Promise<void> {
    const definition = store?.managedSkillPackages.getActive(id, namespace)
        ?? MANAGED_SKILL_LIBRARY.find((skill) => skill.id === id)
    const payload = payloadFor(id, store, namespace)
    if (!definition || !payload) throw new Error(`Unknown SHAPI skill: ${id}`)
    if (!machine.active) throw new Error(`Runner ${machine.metadata?.displayName ?? machine.id} is offline`)
    const runnerVersion = machine.metadata?.runnerVersion
    if (!runnerVersion || compareVersions(runnerVersion, definition.minimumRunnerVersion) < 0) {
        throw new Error(`Runner must be upgraded to ${definition.minimumRunnerVersion} before using ${definition.name}`)
    }
    const cached = machine.metadata?.managedSkills?.[id]
    if (cached?.state === 'ready' && cached.version === payload.version && cached.sha256 === payload.sha256) return

    const result = ManagedSkillReconcileResponseSchema.parse(await engine.reconcileManagedSkill(machine.id, payload))
    if (!result.success || result.status.state !== 'ready') {
        throw new Error(result.status.error ?? `Could not cache ${definition.name}`)
    }
}

export async function ensureManagedSkillForSession(
    engine: SyncEngine,
    sessionId: string,
    text: string | undefined,
    options?: { store: Store; namespace: string }
): Promise<void> {
    const id = findManagedSkillInvocation(text, options?.store, options?.namespace)
    if (!id) return
    if (options && !isManagedSkillEnabled(options.store, options.namespace, id)) {
        throw new Error(`SHAPI skill ${id} is disabled`)
    }
    const machineId = engine.getSession(sessionId)?.metadata?.machineId?.trim()
    const machine = machineId ? engine.getMachine(machineId) : undefined
    if (!machine) throw new Error('Session Runner is unavailable')
    await ensureManagedSkillCached(engine, machine, id, options?.store, options?.namespace)
}

export function managedSkillMachineState(machine: Machine, skill: ManagedSkillCatalogEntry): ManagedSkillMachineState {
    const installed = machine.metadata?.managedSkills?.[skill.id]
    const runnerVersion = machine.metadata?.runnerVersion ?? null
    let state: ManagedSkillMachineState['state']
    if (!machine.active) state = 'offline'
    else if (!runnerVersion || compareVersions(runnerVersion, skill.minimumRunnerVersion) < 0) state = 'unsupported'
    else if (!installed) state = 'missing'
    else if (installed.state === 'conflict') state = 'conflict'
    else if (installed.state === 'error') state = 'error'
    else if (installed.version !== skill.version || installed.sha256 !== skill.sha256) state = 'outdated'
    else state = 'ready'
    return {
        machineId: machine.id,
        displayName: machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id,
        active: machine.active,
        runnerVersion,
        desiredVersion: skill.version,
        installedVersion: installed?.version ?? null,
        state
    }
}
