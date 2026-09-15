import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { configuration } from '@/configuration'
import { readSettings, updateSettings } from '@/persistence'
import { approveRunnerDeviceAuthorizationWithWebToken, createRunnerDeviceAuthorization, pollRunnerDeviceAuthorization } from './client'
import { resolveAuthV2HubUrl } from './hubUrl'
import {
    generateRunnerKeyMaterial,
    normalizeHubUrl,
    readRunnerCredential,
    writeRunnerCredential,
    type ApprovedRunnerCredential,
    type PendingRunnerCredential
} from './credentials'

type PairRunnerOptions = {
    displayName?: string
    hubUrl?: string
    fetcher?: typeof fetch
    sleep?: (milliseconds: number) => Promise<void>
    now?: () => number
    output?: (message: string) => void
    webToken?: string
}

export function parseRunnerPairArgs(args: string[]): { displayName?: string; hubUrl?: string; webTokenFile?: string } {
    const result: { displayName?: string; hubUrl?: string; webTokenFile?: string } = {}
    for (let index = 0; index < args.length; index++) {
        const flag = args[index]
        if (flag !== '--name' && flag !== '--hub' && flag !== '--web-token-file') {
            throw new Error('Usage: shapi runner pair --hub <url> [--name <display-name>] [--web-token-file <path>]')
        }
        const value = args[++index]?.trim()
        const duplicate = flag === '--name' ? result.displayName : flag === '--hub' ? result.hubUrl : result.webTokenFile
        if (!value || duplicate) {
            throw new Error('Usage: shapi runner pair --hub <url> [--name <display-name>] [--web-token-file <path>]')
        }
        if (flag === '--name') result.displayName = value
        else if (flag === '--hub') result.hubUrl = value
        else result.webTokenFile = value
    }
    return result
}

export async function pairRunner(options: PairRunnerOptions = {}): Promise<ApprovedRunnerCredential> {
    const hubUrl = await resolveAuthV2HubUrl(options.hubUrl)
    const fetcher = options.fetcher ?? fetch
    const sleep = options.sleep ?? ((milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds)))
    const now = options.now ?? Date.now
    const output = options.output ?? console.log
    const existing = await readRunnerCredential(hubUrl)
    if (existing?.status === 'approved') {
        throw new Error(`This machine is already paired with ${hubUrl}`)
    }

    let pending: PendingRunnerCredential
    let intervalMs: number
    if (existing?.status === 'pending' && existing.expiresAt > now()) {
        pending = existing
        intervalMs = existing.pollIntervalMs
        output(`Resuming pending runner pairing for ${hubUrl}`)
    } else {
        const settings = await readSettings()
        const machineId = z.string().uuid().safeParse(settings.machineId).success
            ? settings.machineId!
            : randomUUID()
        const displayName = options.displayName?.trim() || os.hostname()
        if (displayName.length > 100) throw new Error('Runner display name must be at most 100 characters')
        const keyMaterial = generateRunnerKeyMaterial()
        const authorization = await createRunnerDeviceAuthorization(hubUrl, {
            runnerToken: keyMaterial.runnerToken,
            machineId,
            displayName,
            publicJwk: keyMaterial.publicJwk,
            publicKeyThumbprint: keyMaterial.publicKeyThumbprint
        }, fetcher)
        pending = {
            version: 1,
            status: 'pending',
            hubUrl,
            runnerToken: keyMaterial.runnerToken,
            machineId,
            displayName,
            publicJwk: keyMaterial.publicJwk,
            privateJwk: keyMaterial.privateJwk,
            publicKeyThumbprint: keyMaterial.publicKeyThumbprint,
            deviceCode: authorization.deviceCode,
            userCode: authorization.userCode,
            expiresAt: now() + authorization.expiresIn * 1_000,
            pollIntervalMs: Math.max(1_000, authorization.interval * 1_000)
        }
        intervalMs = pending.pollIntervalMs
        await writeRunnerCredential(pending)
        if (!options.webToken) {
            output(`Open: ${authorization.verificationUri}`)
            output(`Enter code: ${authorization.userCode}`)
        }
    }

    let pollImmediately = false
    if (options.webToken) {
        await approveRunnerDeviceAuthorizationWithWebToken(hubUrl, pending.userCode, options.webToken, fetcher)
        output('Runner pairing approved with the Web credential')
        pollImmediately = true
    }

    while (now() < pending.expiresAt) {
        if (!pollImmediately) await sleep(intervalMs)
        pollImmediately = false
        const result = await pollRunnerDeviceAuthorization(hubUrl, pending.deviceCode, fetcher)
        if (result.status === 'pending') continue
        if (result.status === 'slow_down') {
            intervalMs = Math.max(intervalMs + 5_000, (result.retryAfter ?? 0) * 1_000)
            continue
        }
        if (result.status === 'denied') throw new Error('Runner pairing was denied')
        if (result.status === 'expired') throw new Error('Runner pairing expired')
        if (result.machineId !== pending.machineId) {
            throw new Error('Hub approved a different machine ID')
        }
        const approved: ApprovedRunnerCredential = {
            version: 1,
            status: 'approved',
            hubUrl,
            runnerToken: pending.runnerToken,
            machineId: pending.machineId,
            displayName: pending.displayName,
            publicJwk: pending.publicJwk,
            privateJwk: pending.privateJwk,
            publicKeyThumbprint: pending.publicKeyThumbprint,
            workspaceId: result.workspaceId,
            accessKeyId: result.accessKeyId,
            approvedAt: now()
        }
        await writeRunnerCredential(approved)
        await updateSettings(current => ({ ...current, machineId: approved.machineId }))
        configuration._setCliApiToken(approved.runnerToken)
        output(`Runner paired with ${hubUrl}`)
        return approved
    }
    throw new Error('Runner pairing expired')
}

export async function handleRunnerPairCommand(args: string[]): Promise<void> {
    const parsed = parseRunnerPairArgs(args)
    const webToken = parsed.webTokenFile ? (await readFile(parsed.webTokenFile, 'utf8')).trim() : undefined
    if (parsed.webTokenFile && !/^spw[A-Za-z0-9_-]{43}$/.test(webToken ?? '')) {
        throw new Error('Invalid spw credential')
    }
    await pairRunner({ displayName: parsed.displayName, hubUrl: parsed.hubUrl, webToken })
}
