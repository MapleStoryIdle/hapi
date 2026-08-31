import { describe, expect, it } from 'vitest'
import {
    decodeFilePathHref,
    decodeFilePathLinkHref,
    isProjectFilePathTarget,
    parseAbsoluteFilePathHref,
    parseProjectFilePathHref,
    remarkFilePathLinks,
    type FilePathLinkOptions
} from '@/lib/remark-file-path-links'

type TestNode = {
    type: string
    value?: string
    url?: string
    children?: TestNode[]
}

function transform(text: string, options?: FilePathLinkOptions): TestNode[] {
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }]
    }
    remarkFilePathLinks(options)(tree)
    return tree.children?.[0]?.children ?? []
}

function transformExplicitLink(href: string, options?: FilePathLinkOptions): TestNode {
    const link: TestNode = {
        type: 'link',
        url: href,
        children: [{ type: 'text', value: 'Open file' }]
    }
    const tree: TestNode = {
        type: 'root',
        children: [{ type: 'paragraph', children: [link] }]
    }
    remarkFilePathLinks(options)(tree)
    return link
}

function linkedPath(node: TestNode): string | null {
    return typeof node.url === 'string' ? decodeFilePathHref(node.url) : null
}

describe('remarkFilePathLinks', () => {
    it('links relative code paths and strips line suffixes from the target path', () => {
        const nodes = transform('Open web/src/router.tsx:42 please')
        const link = nodes.find((node) => node.type === 'link')

        expect(link?.children?.[0]?.value).toBe('web/src/router.tsx:42')
        expect(linkedPath(link!)).toBe('web/src/router.tsx')
        expect(decodeFilePathLinkHref(link!.url!)).toEqual({
            path: 'web/src/router.tsx',
            line: 42
        })
    })

    it('links relative code paths with line and column targets', () => {
        const nodes = transform('Open web/src/router.tsx:42:7 please')
        const link = nodes.find((node) => node.type === 'link')

        expect(link?.children?.[0]?.value).toBe('web/src/router.tsx:42:7')
        expect(decodeFilePathLinkHref(link!.url!)).toEqual({
            path: 'web/src/router.tsx',
            line: 42,
            column: 7
        })
    })

    it('links image and markdown filenames for preview', () => {
        const nodes = transform('See screenshot.png and README.md')
        const links = nodes.filter((node) => node.type === 'link')

        expect(links.map(linkedPath)).toEqual(['screenshot.png', 'README.md'])
    })

    it('leaves explicit relative Markdown links for the chat-aware anchor', () => {
        const link = transformExplicitLink('web/src/router.tsx:42:7')

        expect(link.url).toBe('web/src/router.tsx:42:7')
    })

    it('parses encoded absolute project paths with Unicode, spaces, and coordinates', () => {
        const workspacePath = '/Users/dev/IdeaProjects/homebar-cloud'
        const rawPath = `${workspacePath}/doc/${encodeURIComponent('中文 文件.md')}:42:7`

        expect(parseProjectFilePathHref(rawPath, { workspacePath })).toEqual({
            path: `${workspacePath}/doc/中文 文件.md`,
            line: 42,
            column: 7
        })
    })

    it('keeps a valid line when the optional column is zero', () => {
        const nodes = transform('Open README.md:42:0')
        const link = nodes.find((node) => node.type === 'link')

        expect(decodeFilePathLinkHref(link!.url!)).toEqual({
            path: 'README.md',
            line: 42
        })
    })

    it('matches Windows drive-root paths against slash- and case-normalized workspaces', () => {
        const workspacePath = 'C:\\Repo'
        const rawPath = 'C:/repo/src/App.tsx:42:7'
        const backslashRawPath = 'C:\\repo\\src\\App.tsx:42:7'

        expect(parseProjectFilePathHref(rawPath, { workspacePath })).toEqual({
            path: 'C:/repo/src/App.tsx',
            line: 42,
            column: 7
        })
        expect(parseProjectFilePathHref(backslashRawPath, { workspacePath })).toEqual({
            path: 'C:\\repo\\src\\App.tsx',
            line: 42,
            column: 7
        })

        const nodes = transform(`Open ${rawPath}`, { workspacePath })
        const link = nodes.find((node) => node.type === 'link')
        expect(decodeFilePathLinkHref(link!.url!)).toEqual({
            path: 'C:/repo/src/App.tsx',
            line: 42,
            column: 7
        })
    })

    it('uses platform-aware containment and keeps session workspace paths raw', () => {
        const posixWorkspace = '/tmp/project'
        expect(parseProjectFilePathHref('/tmp/project/docs/secret.md', { workspacePath: posixWorkspace })).toEqual({
            path: '/tmp/project/docs/secret.md'
        })
        expect(parseProjectFilePathHref('/tmp/project\\outside/secret.md', { workspacePath: posixWorkspace })).toBeNull()

        const encodedWorkspace = '/tmp/project%2Fescape'
        expect(parseProjectFilePathHref('/tmp/project/escape/secret.md', { workspacePath: encodedWorkspace })).toBeNull()
        expect(parseProjectFilePathHref('/tmp/project%252Fescape/secret.md', { workspacePath: encodedWorkspace })).toEqual({
            path: '/tmp/project%2Fescape/secret.md'
        })

        expect(parseProjectFilePathHref('c:/repo\\src/App.tsx:42', { workspacePath: 'C:\\Repo' })).toEqual({
            path: 'c:/repo\\src/App.tsx',
            line: 42
        })
    })

    it('does not mistake double-slash custom schemes for Windows drive paths', () => {
        expect(parseProjectFilePathHref('x://repo/file.ts', { workspacePath: 'X:/repo' })).toBeNull()
        expect(parseProjectFilePathHref('c://repo/file.ts', { workspacePath: 'C:/repo' })).toBeNull()
    })

    it('auto-links encoded absolute project paths only with the session workspace', () => {
        const workspacePath = '/Users/dev/IdeaProjects/homebar-cloud'
        const rawPath = `${workspacePath}/doc/${encodeURIComponent('中文 文件.md')}:42`
        const nodes = transform(`Open ${rawPath}`, { workspacePath })
        const link = nodes.find((node) => node.type === 'link')

        expect(decodeFilePathLinkHref(link!.url!)).toEqual({
            path: `${workspacePath}/doc/中文 文件.md`,
            line: 42
        })
    })

    it('identifies external absolute file paths without granting project-file access', () => {
        const workspacePath = '/Users/dev/IdeaProjects/homebar-cloud'
        const externalHref = '/Users/dev/IdeaProjects/other-project/doc/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md:42'

        expect(parseProjectFilePathHref(externalHref, { workspacePath })).toBeNull()
        expect(parseAbsoluteFilePathHref(externalHref)).toEqual({
            path: '/Users/dev/IdeaProjects/other-project/doc/中文 文件.md',
            line: 42
        })
    })

    it('recognizes encoded absolute traversal for unavailable chips but rejects viewer access', () => {
        const workspacePath = '/Users/dev/project'
        const posixHref = '/Users/dev/project/%2E%2E/other/README.md'
        const posixPath = '/Users/dev/project/../other/README.md'
        const windowsHref = 'C:/repo/%2E%2E/other/README.md'
        const windowsPath = 'C:/repo/../other/README.md'

        expect(parseProjectFilePathHref(posixHref, { workspacePath })).toBeNull()
        expect(parseAbsoluteFilePathHref(posixHref)).toEqual({ path: posixPath })
        expect(isProjectFilePathTarget({ path: posixPath }, { workspacePath })).toBe(false)

        expect(parseProjectFilePathHref(windowsHref, { workspacePath: 'C:/repo' })).toBeNull()
        expect(parseAbsoluteFilePathHref(windowsHref)).toEqual({ path: windowsPath })
        expect(isProjectFilePathTarget({ path: windowsPath }, { workspacePath: 'C:/repo' })).toBe(false)

        expect(isProjectFilePathTarget({
            path: 'web/src/router.tsx',
            line: 42,
            column: 7
        }, { workspacePath })).toBe(true)
    })

    it('uses path safety rather than Markdown file heuristics for protocol targets', () => {
        const workspacePath = '/Users/dev/project'

        for (const path of ['a', 'go', 'Makefile', 'src\\App.tsx']) {
            expect(isProjectFilePathTarget({ path }, { workspacePath })).toBe(true)
        }

        for (const path of [
            '../secret',
            'src/../secret',
            'vscode://file/secret',
            'file:///secret',
            '~/secret',
            '~\\secret',
            '//server/share/file',
            '\\\\server\\share\\file',
            '\0secret',
        ]) {
            expect(isProjectFilePathTarget({ path }, { workspacePath })).toBe(false)
        }
    })

    it('keeps raw Markdown auto-linking conservative for protocol-only paths', () => {
        const nodes = transform('Open a, go, Makefile, and src\\App.tsx')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('does not link auto-detected paths that are outside the session workspace', () => {
        const nodes = transform('Skip /Users/dev/project/a.png, ~/a.png, ../a.png and C:\\tmp\\a.png')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })

    it('leaves project-external absolute paths and ordinary URLs for anchor classification', () => {
        const workspacePath = '/Users/dev/IdeaProjects/homebar-cloud'
        const externalPath = '/Users/dev/IdeaProjects/other-project/doc/README.md'
        const external = transformExplicitLink(externalPath, { workspacePath })
        const https = transformExplicitLink('https://example.com/docs/README.md', { workspacePath })
        const http = transformExplicitLink('http://example.com/components/App.tsx', { workspacePath })

        expect(external.url).toBe(externalPath)
        expect(https.url).toBe('https://example.com/docs/README.md')
        expect(http.url).toBe('http://example.com/components/App.tsx')
    })

    it('does not classify routes, traversal, query, anchor, or custom-scheme hrefs as files', () => {
        const workspacePath = '/Users/dev/IdeaProjects/homebar-cloud'
        expect(parseProjectFilePathHref('/settings', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('/etc/hosts.md', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('../secrets.md', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('file:///Users/dev/IdeaProjects/homebar-cloud/doc/README.md', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('#readme', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('README.md?raw=1', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('vscode://file/README.md', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('//server/share/README.md', { workspacePath })).toBeNull()
        expect(parseProjectFilePathHref('\\\\server\\share\\README.md', { workspacePath })).toBeNull()
    })

    it('does not rewrite ordinary URLs in text', () => {
        const nodes = transform('Visit https://example.com/web/src/router.tsx')

        expect(nodes.some((node) => node.type === 'link')).toBe(false)
    })
})
