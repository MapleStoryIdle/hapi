import { describe, expect, it } from 'bun:test'
import {
    SESSION_REFERENCE_STEER_SUFFIX,
    buildSessionCitationSteerInstruction,
    extractSessionCitationIds,
    normalizeSessionIdPrefix
} from './sessionCitation'

const SESSION_ID = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'

describe('sessionCitation', () => {
    it('能从支持的引用格式提取会话 ID', () => {
        expect(extractSessionCitationIds(`See session "Coding" (/sessions/${SESSION_ID}) for context`)).toEqual([SESSION_ID])
        expect(extractSessionCitationIds(`[Coding](/sessions/${SESSION_ID})`)).toEqual([SESSION_ID])
        expect(extractSessionCitationIds(`see /sessions/${SESSION_ID}.`)).toEqual([SESSION_ID])
    })

    it('拒绝看起来像本地源文件的路径，并保留首次出现顺序', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(extractSessionCitationIds('see web/src/routes/sessions/chat.tsx')).toEqual([])
        expect(extractSessionCitationIds(`[A](/sessions/${SESSION_ID}) and [B](/sessions/${other}) and /sessions/${SESSION_ID}`)).toEqual([SESSION_ID, other])
    })

    it('规范化单个引用，并在多个引用时拒绝猜测', () => {
        const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        expect(normalizeSessionIdPrefix(`See session "Coding" (/sessions/${SESSION_ID}) for context.${SESSION_REFERENCE_STEER_SUFFIX}`)).toBe(SESSION_ID)
        expect(normalizeSessionIdPrefix(`[Coding](/sessions/${SESSION_ID})`)).toBe(SESSION_ID)
        expect(normalizeSessionIdPrefix(`[A](/sessions/${SESSION_ID}) and [B](/sessions/${other})`)).toBe('')
    })

    it('生成的系统提示明确禁止按本地文件读取会话路径', () => {
        const text = buildSessionCitationSteerInstruction({
            inspectTool: 'mcp__hapi__inspect_peer',
            pingTool: 'mcp__hapi__ping_peer',
            listPeersTool: 'mcp__hapi__list_peers'
        })
        expect(text).toContain('mcp__hapi__inspect_peer')
        expect(text).toContain('mcp__hapi__list_peers')
        expect(text.toLowerCase()).toContain('not a local filesystem path')
    })
})
