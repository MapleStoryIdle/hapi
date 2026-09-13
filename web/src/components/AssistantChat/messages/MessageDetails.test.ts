import { afterEach, describe, expect, it } from 'vitest'
import { getTurnUsageDisplay, shouldIgnoreMessageDetailsToggle } from './MessageDetails'

afterEach(() => {
    window.getSelection()?.removeAllRanges()
    document.body.replaceChildren()
})

describe('getTurnUsageDisplay', () => {
    it('formats compact per-turn totals and cache share', () => {
        expect(getTurnUsageDisplay({
            input_tokens: 28_400,
            output_tokens: 3_000,
            cache_read_input_tokens: 21_584
        })).toEqual({
            total: '31.4K',
            input: '28.4K',
            output: '3K',
            cachePercent: 76
        })
    })
})

function eventFor(target: Element) {
    return { target } as never
}

describe('shouldIgnoreMessageDetailsToggle', () => {
    it('ignores nested interactive controls inside a message', () => {
        const button = document.createElement('button')

        // 验证点击复制/链接等控件时不会误触发展开消息详情。
        expect(shouldIgnoreMessageDetailsToggle(eventFor(button))).toBe(true)
    })

    it('allows plain message body clicks to reveal message details', () => {
        const body = document.createElement('div')

        // 验证普通正文点击可以作为“展开时间/信息”的手势。
        expect(shouldIgnoreMessageDetailsToggle(eventFor(body))).toBe(false)
    })

    it('ignores clicks while text is selected', () => {
        const body = document.createElement('div')
        body.textContent = 'selectable message text'
        document.body.append(body)
        const range = document.createRange()
        range.selectNodeContents(body)
        window.getSelection()?.addRange(range)

        // 验证用户选择/复制文字时不会因为 mouseup/click 把详情打开。
        expect(shouldIgnoreMessageDetailsToggle(eventFor(body))).toBe(true)
    })
})
