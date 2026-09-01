import { describe, expect, test } from 'vitest'
import { decodeShareFilename, decodeShareHeaderText, readShareBody } from './cli'

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        }
    })
}

describe('public share upload ingress helpers', () => {
    test('accepts canonical base64url UTF-8 filenames only', () => {
        const chinese = Buffer.from('报告.md', 'utf8').toString('base64url')
        expect(decodeShareFilename(chinese)).toBe('报告.md')
        expect(decodeShareFilename(Buffer.from('../bad', 'utf8').toString('base64url'))).toBeNull()
        expect(decodeShareFilename(Buffer.from('a\n', 'utf8').toString('base64url'))).toBeNull()
        expect(decodeShareFilename('not+base64')).toBeNull()
    })

    test('rechecks the byte limit after Unicode normalization', () => {
        const expandsDuringNfc = Buffer.from('\u0344', 'utf8').toString('base64url')
        expect(decodeShareHeaderText(expandsDuringNfc, 2)).toBeNull()
    })

    test('reads chunks incrementally and caps before assembling an oversized body', async () => {
        expect(await readShareBody(stream([new Uint8Array([1, 2]), new Uint8Array([3])]))).toEqual(new Uint8Array([1, 2, 3]))
        const overLimit = new Uint8Array(10 * 1024 * 1024 + 1)
        expect(await readShareBody(stream([overLimit]))).toBeNull()
    })
})
