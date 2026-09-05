import { AppWindow, Ban, FileArchive, FileImage, FileText, FileX2, Globe, Hash, Link2, Mail, Puzzle } from 'lucide-react'

// Shared by Markdown links and message-level action links. Navigation and URI
// safety remain with the caller; this component only chooses the visual.
export const MESSAGE_LINK_CLASS = 'aui-md-a message-content-link bg-transparent text-[var(--app-markdown-link)] no-underline [&_code]:bg-transparent'

const FILE_LABELS: Record<string, string> = {
    ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', mjs: 'JS', cjs: 'JS',
    md: 'MD', mdx: 'MD', markdown: 'MD', json: '{}',
    py: 'PY', go: 'GO', rs: 'RS', css: 'CSS', scss: 'CSS',
    html: '</>', xml: '</>', vue: 'VUE', java: 'JAVA', kt: 'KT', swift: 'SW',
    sh: 'SH', zsh: 'SH', bash: 'SH', sql: 'SQL',
    yaml: 'YML', yml: 'YML', toml: 'TOML', pdf: 'PDF', txt: 'TXT',
}

function fileIconType(path: string): string | null {
    const filename = path.split(/[\\/]/).at(-1) ?? ''
    if (filename.toLowerCase() === 'skill.md') return 'skill'
    const extension = filename.includes('.') ? filename.split('.').at(-1)!.toLowerCase() : ''
    if (Object.hasOwn(FILE_LABELS, extension)) return extension
    if (/^(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/.test(extension)) return 'image'
    if (/^(zip|gz|tgz|tar|rar|7z)$/.test(extension)) return 'archive'
    return null
}

function hrefFileType(href: string): string | null {
    // Inspect only the pathname, never a query, fragment, domain or app URI.
    let path = href.split(/[?#]/)[0]
    if (/^(https?:)?\/\//i.test(href)) {
        try {
            path = new URL(href, 'https://shapi.invalid').pathname
        } catch {
            return null
        }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
        return null
    }
    try {
        return fileIconType(decodeURIComponent(path))
    } catch {
        return null
    }
}

export function MessageLinkIcon(props: {
    href?: string
    filePath?: string
    disabled?: boolean
    external?: boolean
}) {
    const href = props.href?.trim() ?? ''
    const fileType = props.filePath ? fileIconType(props.filePath) : hrefFileType(href)
    const isFile = Boolean(props.filePath || fileType)
    const marker = props.disabled ? 'disabled' : isFile ? 'file' : props.external ? 'external' : 'internal'
    const label = !props.disabled && fileType ? FILE_LABELS[fileType] : undefined
    const iconProps = {
        className: 'message-content-link-icon',
        'aria-hidden': true as const,
        'data-markdown-link-icon': marker,
    }

    if (label) {
        return (
            <svg {...iconProps} viewBox="0 0 24 24" fill="none" data-file-type={fileType}>
                <rect x="1" y="1" width="22" height="22" rx="4" fill="currentColor" />
                <text
                    x="12" y="12.5" textAnchor="middle" dominantBaseline="central"
                    fill="var(--app-bg)" fontFamily="ui-sans-serif, system-ui, sans-serif"
                    fontSize={label.length > 3 ? 7 : label.length > 2 ? 8.5 : 11} fontWeight="700"
                >{label}</text>
            </svg>
        )
    }

    let Icon = Link2
    if (props.disabled) Icon = isFile ? FileX2 : Ban
    else if (fileType === 'image') Icon = FileImage
    else if (fileType === 'archive') Icon = FileArchive
    else if (fileType === 'skill') Icon = Puzzle
    else if (isFile) Icon = FileText
    else if (/^mailto:/i.test(href)) Icon = Mail
    else if (href.startsWith('#')) Icon = Hash
    else if (/^(https?:)?\/\//i.test(href)) Icon = Globe
    else if (/^[a-z][a-z\d+.-]*:/i.test(href)) Icon = AppWindow

    return <Icon {...iconProps} strokeWidth={2} />
}
