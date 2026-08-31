const FILE_PATH_HREF_PREFIX = 'hapi-file:'

const PATH_PATTERN = /(?:[A-Za-z]:[\\/](?:[^\s`"\'<>\\/]+[\\/])*[^\s`"\'<>\\/]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|\/(?:[^\s`"\'<>\/]+\/)*[^\s`"\'<>\/]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:\.\/|[A-Za-z0-9_.-]+\/)[^\s`"\'<>]*?\.(?:[A-Za-z0-9]{1,12}|lock)(?::\d+(?::\d+)?)?|(?:[A-Za-z0-9_.-]+\.(?:[A-Za-z0-9]{1,12}|lock))(?::\d+(?::\d+)?)?)/g

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?'])
const COMMON_FILE_EXTENSIONS = new Set([
    'avif', 'bmp', 'c', 'cjs', 'cpp', 'css', 'gif', 'go', 'h', 'hpp', 'html', 'ico', 'java',
    'jpeg', 'jpg', 'js', 'json', 'jsx', 'kt', 'lock', 'md', 'mdx', 'mjs', 'png', 'py', 'rs',
    'markdown', 'scss', 'sh', 'sql', 'svg', 'swift', 'toml', 'ts', 'tsx', 'txt', 'vue', 'webp',
    'xml', 'yaml', 'yml', 'zsh'
])

export type FilePathLinkTarget = {
    path: string
    line?: number
    column?: number
}

export type FilePathLinkOptions = {
    /**
     * The current session workspace. Required before an absolute POSIX or
     * Windows drive-root path can be treated as an internal file link.
     */
    workspacePath?: string | null
}

type MarkdownNode = {
    type?: string
    value?: string
    url?: string
    title?: string | null
    children?: MarkdownNode[]
}

function createFileHref(target: FilePathLinkTarget): string {
    const params = new URLSearchParams()
    if (target.line !== undefined) {
        params.set('line', String(target.line))
    }
    if (target.column !== undefined) {
        params.set('column', String(target.column))
    }
    const suffix = params.toString()
    return `${FILE_PATH_HREF_PREFIX}${encodeURIComponent(target.path)}${suffix ? `?${suffix}` : ''}`
}

function parsePositiveInt(value: string | null): number | undefined {
    if (!value) return undefined
    if (!/^\d+$/.test(value)) return undefined
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function decodeHrefPath(value: string): string | null {
    try {
        return decodeURIComponent(value)
    } catch {
        return null
    }
}

export function decodeFilePathLinkHref(href: string): FilePathLinkTarget | null {
    if (!href.startsWith(FILE_PATH_HREF_PREFIX)) return null
    const payload = href.slice(FILE_PATH_HREF_PREFIX.length)
    const queryIndex = payload.indexOf('?')
    const encodedPath = queryIndex >= 0 ? payload.slice(0, queryIndex) : payload
    const query = queryIndex >= 0 ? payload.slice(queryIndex + 1) : ''
    try {
        const path = decodeURIComponent(encodedPath)
        if (!path) return null
        const params = new URLSearchParams(query)
        const line = parsePositiveInt(params.get('line'))
        const column = parsePositiveInt(params.get('column'))
        return {
            path,
            ...(line !== undefined ? { line } : {}),
            ...(column !== undefined ? { column } : {})
        }
    } catch {
        return null
    }
}

export function decodeFilePathHref(href: string): string | null {
    return decodeFilePathLinkHref(href)?.path ?? null
}

function splitTrailingPunctuation(value: string): { path: string; trailing: string } {
    let path = value
    let trailing = ''

    while (path.length > 0) {
        const last = path[path.length - 1]
        if (TRAILING_PUNCTUATION.has(last)) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ')' && path.split('(').length <= path.split(')').length) {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        if (last === ']' || last === '}') {
            trailing = last + trailing
            path = path.slice(0, -1)
            continue
        }
        break
    }

    return { path, trailing }
}

function stripLineSuffix(value: string): string {
    return value.replace(/:\d+(?::\d+)?$/, '')
}

function parseLineTarget(value: string): FilePathLinkTarget {
    const match = value.match(/^(.*?):(\d+)(?::(\d+))?$/)
    if (!match) return { path: value }
    const line = parsePositiveInt(match[2] ?? null)
    const column = parsePositiveInt(match[3] ?? null)
    return {
        path: match[1] ?? value,
        ...(line !== undefined ? { line } : {}),
        ...(column !== undefined ? { column } : {})
    }
}

function hasKnownFileExtension(value: string): boolean {
    const path = stripLineSuffix(value).toLowerCase()
    const ext = path.slice(path.lastIndexOf('.') + 1)
    return COMMON_FILE_EXTENSIONS.has(ext)
}

function hasUrlScheme(value: string): boolean {
    return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
}

/**
 * A drive-root path has exactly one leading forward slash, or a backslash.
 * `x://…` / `c://…` are URL schemes, not Windows paths.
 */
export function isWindowsDriveRootPath(value: string): boolean {
    return /^[A-Za-z]:(?:\\|\/(?!\/))/.test(value)
}

function isUnsupportedNetworkPath(value: string): boolean {
    // Keep protocol-relative URLs and UNC shares on the normal web-link path:
    // neither has a session-safe local workspace-root mapping.
    return value.startsWith('//') || value.startsWith('\\\\')
}

function hasPathTraversal(value: string): boolean {
    return value.split(/[\\/]/).some((segment) => segment === '..')
}

type NormalizedAbsolutePath = {
    kind: 'posix' | 'windows'
    value: string
}

function normalizePathSegments(value: string, separator: RegExp): string[] | null {
    const segments: string[] = []
    for (const segment of value.split(separator)) {
        if (!segment || segment === '.') continue
        if (segment === '..') return null
        segments.push(segment)
    }
    return segments
}

function normalizeAbsolutePath(value: string): NormalizedAbsolutePath | null {
    if (isWindowsDriveRootPath(value)) {
        const segments = normalizePathSegments(value.slice(3), /[\\/]/)
        if (!segments) return null
        const drive = value.slice(0, 2).toLowerCase()
        return {
            kind: 'windows',
            value: segments.length > 0 ? `${drive}/${segments.join('/')}`.toLowerCase() : `${drive}/`
        }
    }

    if (!value.startsWith('/') || isUnsupportedNetworkPath(value)) {
        return null
    }

    const segments = normalizePathSegments(value, /\//)
    if (!segments) return null
    return {
        kind: 'posix',
        value: segments.length > 0 ? `/${segments.join('/')}` : '/'
    }
}

function isProjectAbsolutePath(path: string, workspacePath: string | null | undefined): boolean {
    const target = normalizeAbsolutePath(path)
    const workspace = workspacePath ? normalizeAbsolutePath(workspacePath) : null
    if (!target || !workspace || target.kind !== workspace.kind) return false
    if (target.value === workspace.value) return true
    return target.value.startsWith(workspace.value.endsWith('/') ? workspace.value : `${workspace.value}/`)
}

type ParsedFilePathHref = {
    target: FilePathLinkTarget
    isAbsolute: boolean
    hasTraversal: boolean
}

function classifyFilePath(path: string): Pick<ParsedFilePathHref, 'isAbsolute' | 'hasTraversal'> | null {
    const windowsDrivePath = isWindowsDriveRootPath(path)
    if (
        !path
        || path.length < 3
        || (!windowsDrivePath && hasUrlScheme(path))
        || path.startsWith('~/')
        || isUnsupportedNetworkPath(path)
    ) {
        return null
    }

    const isAbsolute = path.startsWith('/') || windowsDrivePath
    const hasTraversal = hasPathTraversal(path)
    if (!isAbsolute && (hasTraversal || path.includes('\\'))) {
        return null
    }

    return { isAbsolute, hasTraversal }
}

function parseFilePathHref(href: string): ParsedFilePathHref | null {
    const trimmedHref = href.trim()
    if (!trimmedHref || trimmedHref.includes('?') || trimmedHref.includes('#')) {
        return null
    }

    const decodedHref = decodeHrefPath(trimmedHref)
    if (!decodedHref || /[\0]/.test(decodedHref)) {
        return null
    }

    const target = parseLineTarget(decodedHref)
    const classified = classifyFilePath(target.path)
    if (!classified) {
        return null
    }

    if (!hasKnownFileExtension(target.path)) {
        return null
    }

    return { target, ...classified }
}

type SafeProtocolFilePath = {
    isAbsolute: boolean
}

function classifyProtocolFilePath(path: string): SafeProtocolFilePath | null {
    const windowsDrivePath = isWindowsDriveRootPath(path)
    if (
        !path
        || /[\0]/.test(path)
        || (!windowsDrivePath && hasUrlScheme(path))
        || path === '~'
        || path.startsWith('~/')
        || path.startsWith('~\\')
        || path.startsWith('\\')
        || isUnsupportedNetworkPath(path)
        || hasPathTraversal(path)
    ) {
        return null
    }

    return { isAbsolute: path.startsWith('/') || windowsDrivePath }
}

/**
 * Parses an absolute POSIX or Windows file-looking Markdown href without
 * deciding whether the current session is allowed to open it.
 */
export function parseAbsoluteFilePathHref(href: string): FilePathLinkTarget | null {
    const parsed = parseFilePathHref(href)
    return parsed?.isAbsolute ? parsed.target : null
}

/**
 * Validates an already-decoded hapi-file target before it reaches a session
 * file viewer. Unlike Markdown href detection, this does not require a known
 * extension so legitimate protocol links such as `Makefile` remain usable.
 */
export function isProjectFilePathTarget(
    target: FilePathLinkTarget,
    options: FilePathLinkOptions = {}
): boolean {
    const classified = classifyProtocolFilePath(target.path)
    if (!classified) {
        return false
    }

    return !classified.isAbsolute || isProjectAbsolutePath(target.path, options.workspacePath)
}

/**
 * Parses a Markdown href only when it unambiguously names a file in the
 * current project. Relative paths are project-local by definition; absolute
 * POSIX and Windows drive-root paths require the session workspace boundary
 * supplied by chat metadata. URL/query/fragment/custom-scheme targets remain
 * ordinary links.
 */
export function parseProjectFilePathHref(
    href: string,
    options: FilePathLinkOptions = {}
): FilePathLinkTarget | null {
    const parsed = parseFilePathHref(href)
    if (!parsed) {
        return null
    }

    if (parsed.hasTraversal || (parsed.isAbsolute && !isProjectAbsolutePath(parsed.target.path, options.workspacePath))) {
        return null
    }

    return parsed.target
}

function linkTextNode(node: MarkdownNode, options: FilePathLinkOptions): MarkdownNode[] {
    const value = node.value ?? ''
    const parts: MarkdownNode[] = []
    let lastIndex = 0

    PATH_PATTERN.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = PATH_PATTERN.exec(value)) !== null) {
        const rawMatch = match[0]
        const previousChar = match.index > 0 ? value[match.index - 1] : ''
        if (previousChar === ':' || previousChar === '/' || previousChar === '\\' || previousChar === '.') {
            continue
        }
        const { path: displayPath, trailing } = splitTrailingPunctuation(rawMatch)
        const target = parseProjectFilePathHref(displayPath, options)
        if (!target) {
            continue
        }

        if (match.index > lastIndex) {
            parts.push({ type: 'text', value: value.slice(lastIndex, match.index) })
        }
        parts.push({
            type: 'link',
            url: createFileHref(target),
            title: null,
            children: [{ type: 'text', value: displayPath }]
        })
        if (trailing) {
            parts.push({ type: 'text', value: trailing })
        }
        lastIndex = match.index + rawMatch.length
    }

    if (parts.length === 0) return [node]
    if (lastIndex < value.length) {
        parts.push({ type: 'text', value: value.slice(lastIndex) })
    }
    return parts
}

function visit(node: MarkdownNode, options: FilePathLinkOptions, parentType: string | null = null): void {
    if (!node.children) return
    if (parentType === 'link' || parentType === 'linkReference') return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'link' || child.type === 'linkReference') {
            nextChildren.push(child)
            continue
        }
        if (child.type === 'text') {
            nextChildren.push(...linkTextNode(child, options))
            continue
        }
        visit(child, options, child.type ?? null)
        nextChildren.push(child)
    }
    node.children = nextChildren
}

export function remarkFilePathLinks(options: FilePathLinkOptions = {}) {
    return (tree: MarkdownNode) => visit(tree, options)
}
