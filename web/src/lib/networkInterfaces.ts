import type { MachineHealth } from '@/types/api'

export type MachineNetworkInterface = NonNullable<MachineHealth['networkInterfaces']>[number]

const NOISY_INTERFACE_PREFIXES = ['awdl', 'llw', 'utun', 'lo']

function isDottedIpv4(address: string): boolean {
    const parts = address.split('.')
    if (parts.length !== 4) return false
    return parts.every((part) => {
        if (!/^\d+$/.test(part)) return false
        const value = Number(part)
        return Number.isInteger(value) && value >= 0 && value <= 255
    })
}

function isReachableIpv4(address: string): boolean {
    if (!isDottedIpv4(address)) return false
    const [firstRaw, secondRaw] = address.split('.')
    const first = Number(firstRaw)
    const second = Number(secondRaw)
    if (first === 0 || first === 127 || first === 255) return false
    if (first === 169 && second === 254) return false
    if (first >= 224 && first <= 239) return false
    return true
}

function isLikelyNoisyInterface(name: string): boolean {
    const lower = name.toLowerCase()
    return NOISY_INTERFACE_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

function interfaceRank(name: string): number {
    const lower = name.toLowerCase()
    if (/^(en|eth|wlan|wifi|wi-fi)/.test(lower)) return 0
    if (/^(bridge|ap|anpi)/.test(lower)) return 2
    return 1
}

export function getLanNetworkInterfaces(
    interfaces: MachineHealth['networkInterfaces'] | null | undefined
): MachineNetworkInterface[] {
    return (interfaces ?? [])
        .filter((item) => item.family === 'IPv4' || item.family === '4' || isDottedIpv4(item.address))
        .filter((item) => isReachableIpv4(item.address))
        .filter((item) => !isLikelyNoisyInterface(item.name))
        .sort((left, right) => interfaceRank(left.name) - interfaceRank(right.name)
            || left.name.localeCompare(right.name)
            || left.address.localeCompare(right.address))
}
