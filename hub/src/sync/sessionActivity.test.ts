import { describe, expect, it } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { shouldRecordSessionActivity } from './sessionActivity'

describe('shouldRecordSessionActivity', () => {
    it('records generated-image payloads as visible session activity', () => {
        // 生图是独立可见消息；如果不触发 session activity，会话列表/缓存可能等到下一条文本消息才刷新。
        expect(shouldRecordSessionActivity({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'generated-image',
                    imageId: 'image-1',
                    fileName: 'preview.png',
                    mimeType: 'image/png'
                }
            }
        })).toBe(true)
    })

    it('does not record non-visible agent payloads as session activity', () => {
        // 普通 streaming payload 仍不在这里 touch session，避免把每个流式增量都变成 activity。
        expect(shouldRecordSessionActivity({
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'message-snapshot',
                    message: 'partial'
                }
            }
        })).toBe(false)
    })
})
