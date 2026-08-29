import { describe, expect, test } from 'vitest'
import { decodeArtifactFilename, readArtifactBody } from './cli'

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
        }
    })
}

describe('artifact upload ingress helpers', () => {
    test('accepts canonical base64url UTF-8 filenames only', () => {
        const chinese = Buffer.from('报告.md', 'utf8').toString('base64url')
        expect(decodeArtifactFilename(chinese)).toBe('报告.md')
        expect(decodeArtifactFilename(Buffer.from('../bad', 'utf8').toString('base64url'))).toBeNull()
        expect(decodeArtifactFilename(Buffer.from('a\n', 'utf8').toString('base64url'))).toBeNull()
        expect(decodeArtifactFilename('not+base64')).toBeNull()
    })

    test('reads chunks incrementally and caps before assembling an oversized body', async () => {
        expect(await readArtifactBody(stream([new Uint8Array([1, 2]), new Uint8Array([3])]))).toEqual(new Uint8Array([1, 2, 3]))
        const overLimit = new Uint8Array(10 * 1024 * 1024 + 1)
        expect(await readArtifactBody(stream([overLimit]))).toBeNull()
    })
})
