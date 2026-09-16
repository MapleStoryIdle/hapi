import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { availableParallelism, platform, totalmem } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import type { MachineHealth } from '@hapi/protocol/types'
import { configuration } from '@/configuration'
import { inspectRunnerProcessClaim, listRunnerProcessClaims } from '@/runner/processClaims'

type ProcessRow = {
    pid: number
    ppid: number
    state: string
    cpuPercent: number
    rssBytes: number
}

const DISK_CACHE_MS = 60 * 60_000
const MAX_PS_OUTPUT_BYTES = 8 * 1024 * 1024
let cachedDisk: { path: string; bytes: number; collectedAt: number } | null = null
let diskCollectionInFlight = false
let diskSamplerPid: number | null = null
let diskSampler: ReturnType<typeof spawn> | null = null

export function parseUnixProcessTable(
    output: string,
    excludedPids?: number | ReadonlySet<number>
): ProcessRow[] {
    const excluded = typeof excludedPids === 'number' ? new Set([excludedPids]) : excludedPids
    const rows: ProcessRow[] = []
    for (const line of output.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)$/)
        if (!match) continue
        const pid = Number(match[1])
        const ppid = Number(match[2])
        const cpuPercent = Number(match[4])
        const rssKb = Number(match[5])
        if (
            excluded?.has(pid)
            || !Number.isSafeInteger(pid)
            || !Number.isSafeInteger(ppid)
            || !Number.isFinite(cpuPercent)
            || !Number.isFinite(rssKb)
        ) {
            continue
        }
        rows.push({
            pid,
            ppid,
            state: match[3]?.charAt(0).toUpperCase() ?? '',
            cpuPercent: Math.max(0, cpuPercent),
            rssBytes: Math.max(0, Math.round(rssKb * 1024))
        })
    }
    return rows
}

function readUnixProcessTable(): Promise<ProcessRow[]> {
    return new Promise((resolveRows) => {
        const child = spawn('ps', ['-axo', 'pid=,ppid=,state=,%cpu=,rss='], {
            stdio: ['ignore', 'pipe', 'ignore']
        })
        const chunks: Buffer[] = []
        let byteLength = 0
        let settled = false
        const finish = (rows: ProcessRow[]) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolveRows(rows)
        }
        const timeout = setTimeout(() => {
            child.kill('SIGKILL')
            finish([])
        }, 3_000)
        child.stdout.on('data', (chunk: Buffer) => {
            byteLength += chunk.length
            if (byteLength > MAX_PS_OUTPUT_BYTES) {
                child.kill('SIGKILL')
                finish([])
                return
            }
            chunks.push(chunk)
        })
        child.once('error', () => finish([]))
        child.once('close', (code) => {
            if (code !== 0) {
                finish([])
                return
            }
            const excludedPids = new Set<number>()
            if (child.pid) excludedPids.add(child.pid)
            if (diskSamplerPid) excludedPids.add(diskSamplerPid)
            finish(parseUnixProcessTable(Buffer.concat(chunks).toString('utf8'), excludedPids))
        })
    })
}

export function selectManagedProcessRows(rows: ProcessRow[], rootPids: ReadonlySet<number>): ProcessRow[] {
    const childrenByParent = new Map<number, number[]>()
    const rowsByPid = new Map(rows.map((row) => [row.pid, row]))
    for (const row of rows) {
        const children = childrenByParent.get(row.ppid) ?? []
        children.push(row.pid)
        childrenByParent.set(row.ppid, children)
    }

    const selected = new Set<number>()
    const pending = Array.from(rootPids)
    while (pending.length > 0) {
        const pid = pending.pop()
        if (pid === undefined || selected.has(pid)) continue
        selected.add(pid)
        pending.push(...(childrenByParent.get(pid) ?? []))
    }
    return Array.from(selected)
        .map((pid) => rowsByPid.get(pid))
        .filter((row): row is ProcessRow => row !== undefined)
}

export function summarizeManagedProcessRows(
    rows: ProcessRow[],
    cpuCount: number,
    totalMemoryBytes: number
): Pick<NonNullable<MachineHealth['shapi']>, 'cpuPercent' | 'memoryBytes' | 'memoryPercent' | 'processes'> {
    let rawCpuPercent = 0
    let memoryBytes = 0
    let active = 0
    let sleeping = 0
    let other = 0
    for (const row of rows) {
        rawCpuPercent += row.cpuPercent
        memoryBytes += row.rssBytes
        if (row.state === 'R') active += 1
        else if (row.state === 'S' || row.state === 'I' || row.state === 'D' || row.state === 'U') sleeping += 1
        else other += 1
    }
    const normalizedCpu = rawCpuPercent / Math.max(1, cpuCount)
    const memoryPercent = totalMemoryBytes > 0 ? (memoryBytes / totalMemoryBytes) * 100 : 0
    return {
        cpuPercent: Math.round(Math.max(0, Math.min(100, normalizedCpu)) * 10) / 10,
        memoryBytes,
        memoryPercent: Math.round(Math.max(0, Math.min(100, memoryPercent)) * 10) / 10,
        processes: { total: rows.length, active, sleeping, other }
    }
}

function scheduleManagedDiskCollection(now: number): { path: string; bytes: number } | undefined {
    const home = resolve(configuration.happyHomeDir)
    if (cachedDisk && cachedDisk.path === home && now - cachedDisk.collectedAt < DISK_CACHE_MS) {
        return { path: home, bytes: cachedDisk.bytes }
    }
    if (diskCollectionInFlight) return cachedDisk ? { path: home, bytes: cachedDisk.bytes } : undefined

    diskCollectionInFlight = true
    const child = spawn('du', ['-sk', home], { stdio: ['ignore', 'pipe', 'ignore'] })
    diskSampler = child
    diskSamplerPid = child.pid ?? null
    const chunks: Buffer[] = []
    let outputBytes = 0
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes <= 64 * 1024) chunks.push(chunk)
    })
    child.once('close', (code) => {
        clearTimeout(timeout)
        if (diskSampler !== child) return
        const diskKb = code === 0 ? Number(Buffer.concat(chunks).toString('utf8').trim().split(/\s+/)[0]) : NaN
        const executable = resolve(process.execPath)
        const executableName = basename(executable).toLowerCase()
        const executableInsideHome = executable === home || executable.startsWith(`${home}${sep}`)
        const includeExecutable = !executableInsideHome
            && (executableName === 'hapi' || executableName === 'shapi' || executableName === 'hapi.exe' || executableName === 'shapi.exe')
        void (includeExecutable ? lstat(executable) : Promise.resolve(null))
            .then((stats) => {
                if (!Number.isFinite(diskKb) || diskKb < 0) return
                const executableBytes = stats?.isFile() ? stats.size : 0
                cachedDisk = { path: home, bytes: Math.round(diskKb * 1024 + executableBytes), collectedAt: now }
            })
            .catch(() => {})
            .finally(() => {
                if (diskSampler !== child) return
                diskSampler = null
                diskSamplerPid = null
                diskCollectionInFlight = false
            })
    })
    child.once('error', () => {
        clearTimeout(timeout)
        if (diskSampler !== child) return
        diskSampler = null
        diskSamplerPid = null
        diskCollectionInFlight = false
    })
    return cachedDisk ? { path: home, bytes: cachedDisk.bytes } : undefined
}

export async function collectShapiResourceUsage(
    machineId: string,
    now: number = Date.now()
): Promise<MachineHealth['shapi'] | undefined> {
    if (platform() === 'win32') return undefined

    const claims = await listRunnerProcessClaims()
    const rootPids = new Set<number>([process.pid])
    for (const claim of claims) {
        if (claim.machineId !== machineId || claim.hapiHome !== configuration.happyHomeDir) continue
        if (inspectRunnerProcessClaim(claim).status === 'verified-live') rootPids.add(claim.pid)
    }

    const disk = scheduleManagedDiskCollection(now)
    const processRows = await readUnixProcessTable()
    const managedRows = selectManagedProcessRows(processRows, rootPids)
    const summary = summarizeManagedProcessRows(managedRows, availableParallelism(), totalmem())
    return {
        ...summary,
        ...(disk ? { diskBytes: disk.bytes, diskPath: disk.path } : {})
    }
}

export function resetShapiResourceUsageForTests(): void {
    stopShapiResourceUsageCollection()
    cachedDisk = null
}

export function stopShapiResourceUsageCollection(): void {
    if (diskSampler && diskSampler.exitCode === null && diskSampler.signalCode === null) {
        diskSampler.kill('SIGKILL')
    }
    diskSampler = null
    diskCollectionInFlight = false
    diskSamplerPid = null
}
