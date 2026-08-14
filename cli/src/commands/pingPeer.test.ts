import { describe, expect, it } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parsePingPeerArgs } from './pingPeer'

describe('parsePingPeerArgs', () => {
    it('解析会话前缀、消息、文件和等待参数', () => {
        expect(parsePingPeerArgs(['05d9f0f2', 'hello'])).toEqual({
            help: false,
            list: false,
            sessionIdPrefix: '05d9f0f2',
            message: 'hello'
        })
        expect(parsePingPeerArgs(['abc', '--message-file', 'brief.md', '--wait=30'])).toEqual({
            help: false,
            list: false,
            sessionIdPrefix: 'abc',
            messageFile: 'brief.md',
            waitActiveSecs: 30
        })
    })

    it('支持只读列表，并拒绝未知或冲突参数', () => {
        expect(parsePingPeerArgs(['--list'])).toEqual({ help: false, list: true })
        expect(() => parsePingPeerArgs(['--host', 'bad'])).toThrow(PingPeerError)
        expect(() => parsePingPeerArgs(['--list', 'abc', 'hello'])).toThrow(PingPeerError)
    })
})
