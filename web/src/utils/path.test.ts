import { describe, expect, it } from 'vitest'
import { basename, resolveFullPath } from './path'

describe('file preview display and copy paths', () => {
    it.each([
        ['src/a.ts', '/repo', '/repo/src/a.ts'],
        ['./src/a.ts', '/repo/', '/repo/src/a.ts'],
        ['src/a.ts', '/', '/src/a.ts'],
        ['src/a.ts', 'C:\\repo\\', 'C:\\repo\\src\\a.ts'],
        ['C:\\elsewhere\\a.ts', 'C:\\repo', 'C:\\elsewhere\\a.ts'],
        ['/tmp/a.ts', '/repo', '/tmp/a.ts'],
        ['src/a.ts', undefined, 'src/a.ts'],
    ])('resolves %s using %s without changing absolute paths', (path, root, expected) => {
        expect(resolveFullPath(path, root)).toBe(expected)
        expect(basename(expected)).toBe('a.ts')
    })
})
