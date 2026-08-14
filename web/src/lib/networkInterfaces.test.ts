import { describe, expect, it } from 'vitest'
import { getLanNetworkInterfaces } from './networkInterfaces'

describe('getLanNetworkInterfaces', () => {
    it('keeps reachable IPv4 addresses on normal LAN interfaces', () => {
        expect(getLanNetworkInterfaces([
            { name: 'awdl0', address: 'fe80::6c19:b5ff:fead:dea1', family: 'IPv6' },
            { name: 'en1', address: '192.167.2.29', family: 'IPv4' },
            { name: 'en1', address: '240e:390:6bc:45e0::ef', family: 'IPv6' },
            { name: 'llw0', address: 'fe80::6c19:b5ff:fead:dea1', family: 'IPv6' }
        ])).toEqual([
            { name: 'en1', address: '192.167.2.29', family: 'IPv4' }
        ])
    })

    it('filters loopback, link-local, multicast, and Apple peer interfaces', () => {
        expect(getLanNetworkInterfaces([
            { name: 'lo0', address: '127.0.0.1', family: 'IPv4' },
            { name: 'en0', address: '169.254.1.2', family: 'IPv4' },
            { name: 'awdl0', address: '192.168.2.10', family: 'IPv4' },
            { name: 'utun4', address: '10.10.10.10', family: 'IPv4' },
            { name: 'en0', address: '224.0.0.1', family: 'IPv4' }
        ])).toEqual([])
    })

    it('prioritizes common physical network interfaces', () => {
        expect(getLanNetworkInterfaces([
            { name: 'bridge100', address: '192.168.64.1', family: 'IPv4' },
            { name: 'en0', address: '192.168.1.8', family: 'IPv4' },
            { name: 'vnic0', address: '10.0.0.5', family: 'IPv4' }
        ])).toEqual([
            { name: 'en0', address: '192.168.1.8', family: 'IPv4' },
            { name: 'vnic0', address: '10.0.0.5', family: 'IPv4' },
            { name: 'bridge100', address: '192.168.64.1', family: 'IPv4' }
        ])
    })
})
