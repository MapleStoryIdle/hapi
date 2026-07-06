import { describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '@/chat/types'
import { extractLocalPreviews } from './local-preview'

function agentMessage(text: string, createdAt: number): NormalizedMessage {
    return {
        id: `m-${createdAt}`,
        localId: null,
        createdAt,
        role: 'agent',
        isSidechain: false,
        content: [{ type: 'text', text, uuid: `u-${createdAt}`, parentUUID: null }]
    }
}

describe('extractLocalPreviews', () => {
    it('extracts local web URLs from recent messages', () => {
        const previews = extractLocalPreviews([
            agentMessage('Vite ready at http://localhost:5173/', 1)
        ])

        expect(previews).toEqual([
            {
                id: 'http:5173',
                protocol: 'http',
                port: 5173,
                path: '/',
                sourceUrl: 'http://localhost:5173/',
                detectedAt: 1
            }
        ])
    })

    it('dedupes by protocol and port using the latest path', () => {
        const previews = extractLocalPreviews([
            agentMessage('first http://127.0.0.1:3000/', 1),
            agentMessage('latest http://0.0.0.0:3000/admin?tab=1.', 2)
        ])

        expect(previews).toHaveLength(1)
        expect(previews[0]?.path).toBe('/admin?tab=1')
        expect(previews[0]?.detectedAt).toBe(2)
    })

    it('ignores non-local URLs', () => {
        expect(extractLocalPreviews([
            agentMessage('https://example.com http://192.168.1.10:8080', 1)
        ])).toEqual([])
    })
})
