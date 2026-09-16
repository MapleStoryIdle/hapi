import { accessSync, constants, readFileSync, statfsSync } from 'node:fs'
import { availableParallelism, cpus, freemem, homedir, loadavg, networkInterfaces, platform, totalmem, uptime } from 'node:os'
import { delimiter, join } from 'node:path'
import type { MachineHealth } from '@hapi/protocol/types'
import { MachineHealthSchema } from '@hapi/protocol/schemas'

type CpuTimesSnapshot = {
    idle: number
    total: number
}

let previousCpuSnapshot: CpuTimesSnapshot | null = null

function sumCpuTimes(): CpuTimesSnapshot | null {
    const cores = cpus()
    if (cores.length === 0) {
        return null
    }

    let idle = 0
    let total = 0
    for (const core of cores) {
        const times = core.times
        idle += times.idle
        total += times.user + times.nice + times.sys + times.idle + times.irq
    }

    return { idle, total }
}

function computeCpuPercent(current: CpuTimesSnapshot, previous: CpuTimesSnapshot): number | undefined {
    const idleDelta = current.idle - previous.idle
    const totalDelta = current.total - previous.total
    if (totalDelta <= 0) {
        return undefined
    }

    const usage = 1 - idleDelta / totalDelta
    return Math.max(0, Math.min(100, Math.round(usage * 100)))
}

function parseMeminfoKbValue(meminfo: string, key: string): number | undefined {
    for (const line of meminfo.split('\n')) {
        if (!line.startsWith(`${key}:`)) {
            continue
        }
        const kb = Number(line.split(/\s+/)[1])
        return Number.isFinite(kb) ? kb * 1024 : undefined
    }
    return undefined
}

/** Linux pressure percent: (MemTotal - MemAvailable) / MemTotal. Testable without /proc. */
export function readLinuxMemoryUsedPercent(meminfo: string): number | undefined {
    const total = parseMeminfoKbValue(meminfo, 'MemTotal')
    if (!total || total <= 0) {
        return undefined
    }

    const available = parseMeminfoKbValue(meminfo, 'MemAvailable')
    if (available !== undefined) {
        return Math.max(0, Math.min(100, Math.round(((total - available) / total) * 100)))
    }

    // Pre-3.14 kernels: approximate available as free + reclaimable cache.
    const free = parseMeminfoKbValue(meminfo, 'MemFree')
    if (free === undefined) {
        return undefined
    }
    const buffers = parseMeminfoKbValue(meminfo, 'Buffers') ?? 0
    const cached = parseMeminfoKbValue(meminfo, 'Cached') ?? 0
    const approxAvailable = free + buffers + cached
    return Math.max(0, Math.min(100, Math.round(((total - approxAvailable) / total) * 100)))
}

function computeMemoryPercent(): number | undefined {
    if (platform() === 'linux') {
        try {
            const fromProc = readLinuxMemoryUsedPercent(readFileSync('/proc/meminfo', 'utf8'))
            if (fromProc !== undefined) {
                return fromProc
            }
        } catch {
            // fall through to os.freemem()
        }
    }

    const total = totalmem()
    if (total <= 0) {
        return undefined
    }

    const used = total - freemem()
    return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
}

function isUnixLikeLoadPlatform(): boolean {
    return platform() !== 'win32'
}

function computeUptimeSeconds(): number | undefined {
    const seconds = uptime()
    if (!Number.isFinite(seconds) || seconds < 0) {
        return undefined
    }
    return Math.floor(seconds)
}

function computeDiskHealth(): MachineHealth['disk'] | undefined {
    const path = homedir() || '/'
    try {
        const stats = statfsSync(path)
        const totalBytes = stats.blocks * stats.bsize
        const freeBytes = stats.bavail * stats.bsize
        if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes) || freeBytes < 0) {
            return undefined
        }
        const usedPercent = Math.max(0, Math.min(100, Math.round(((totalBytes - freeBytes) / totalBytes) * 100)))
        return { path, totalBytes, freeBytes, usedPercent }
    } catch {
        return undefined
    }
}

function listNetworkInterfaces(): MachineHealth['networkInterfaces'] | undefined {
    const entries = Object.entries(networkInterfaces())
        .flatMap(([name, addresses]) => (addresses ?? [])
            .filter((address) => !address.internal)
            .map((address) => ({
                name,
                address: address.address,
                family: String(address.family)
            })))
        .sort((left, right) => left.name.localeCompare(right.name) || left.address.localeCompare(right.address))
        .slice(0, 8)
    return entries.length > 0 ? entries : undefined
}

type KnownAgentCli = {
    id: string
    label: string
    command: string
}

const KNOWN_AGENT_CLIS: KnownAgentCli[] = [
    { id: 'claude', label: 'Claude Code', command: 'claude' },
    { id: 'codex', label: 'Codex', command: 'codex' },
    { id: 'cursor', label: 'Cursor', command: 'cursor-agent' },
    { id: 'gemini', label: 'Gemini', command: 'gemini' },
    { id: 'opencode', label: 'OpenCode', command: 'opencode' }
]

function commandExists(command: string): boolean {
    const pathValue = process.env.PATH ?? ''
    if (!pathValue.trim()) {
        return false
    }
    const extensions = platform() === 'win32'
        ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
        : ['']

    for (const dir of pathValue.split(delimiter)) {
        if (!dir) continue
        for (const ext of extensions) {
            try {
                accessSync(join(dir, `${command}${ext}`), constants.X_OK)
                return true
            } catch {
                // Keep scanning PATH entries.
            }
        }
    }
    return false
}

function listAgentCliStatus(): MachineHealth['agentCli'] {
    return KNOWN_AGENT_CLIS.map((cli) => ({
        ...cli,
        available: commandExists(cli.command)
    }))
}

export function collectMachineHealth(
    now: number = Date.now(),
    shapi?: MachineHealth['shapi']
): MachineHealth {
    const cpuCount = availableParallelism()
    const memoryPercent = computeMemoryPercent()
    const uptimeSeconds = computeUptimeSeconds()
    const disk = computeDiskHealth()
    const network = listNetworkInterfaces()
    const agentCli = listAgentCliStatus()
    const load1m = isUnixLikeLoadPlatform() ? loadavg()[0] : undefined

    const cpuSnapshot = sumCpuTimes()
    let cpuPercent: number | undefined
    if (cpuSnapshot && previousCpuSnapshot) {
        cpuPercent = computeCpuPercent(cpuSnapshot, previousCpuSnapshot)
    }
    if (cpuSnapshot) {
        previousCpuSnapshot = cpuSnapshot
    }

    const health = {
        collectedAt: now,
        cpuCount,
        ...(load1m !== undefined ? { load1m } : {}),
        ...(cpuPercent !== undefined ? { cpuPercent } : {}),
        ...(memoryPercent !== undefined ? { memoryPercent } : {}),
        ...(uptimeSeconds !== undefined ? { uptimeSeconds } : {}),
        ...(disk !== undefined ? { disk } : {}),
        ...(shapi !== undefined ? { shapi } : {}),
        ...(network !== undefined ? { networkInterfaces: network } : {}),
        agentCli
    }

    const parsed = MachineHealthSchema.safeParse(health)
    if (!parsed.success) {
        return { collectedAt: now }
    }
    return parsed.data
}

/** Test helper */
export function resetMachineHealthSamplerForTests(): void {
    previousCpuSnapshot = null
}
