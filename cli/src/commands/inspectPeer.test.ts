import { describe, expect, it } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parseInspectPeerArgs } from './inspectPeer'

describe('parseInspectPeerArgs', () => {
    it('解析会话前缀和文本页大小', () => {
        expect(parseInspectPeerArgs(['abcdef12', '--limit', '50'])).toEqual({
            help: false,
            sessionIdPrefix: 'abcdef12',
            messageLimit: 50
        })
    })

    it('拒绝未知参数', () => {
        expect(() => parseInspectPeerArgs(['--host', 'bad'])).toThrow(PingPeerError)
    })
})
