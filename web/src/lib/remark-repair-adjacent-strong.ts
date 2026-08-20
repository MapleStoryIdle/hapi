/**
 * CommonMark leaves `**label**text` as literal text because the closing
 * delimiter is immediately followed by a word character. That is especially
 * visible in Chinese writing, where a label such as `**下一步：**先定位` has no
 * natural space after it. Repair only the otherwise-unparsed strong sequence
 * after Markdown has built the tree; existing strong, code, and link nodes
 * are left untouched.
 */
interface MarkdownNode {
    type: string
    value?: string
    children?: MarkdownNode[]
}

const ADJACENT_STRONG = /(?<!\\)\*\*([^\s*\n](?:[^*\n]*?[^\s*\n])?)\*\*(?=[\p{L}\p{N}])/gu

function splitAdjacentStrong(value: string): MarkdownNode[] {
    const nodes: MarkdownNode[] = []
    let cursor = 0
    let match: RegExpExecArray | null

    ADJACENT_STRONG.lastIndex = 0
    while ((match = ADJACENT_STRONG.exec(value)) !== null) {
        const start = match.index
        if (start > cursor) {
            nodes.push({ type: 'text', value: value.slice(cursor, start) })
        }
        nodes.push({
            type: 'strong',
            children: [{ type: 'text', value: match[1] }]
        })
        cursor = start + match[0].length
    }

    if (cursor === 0) return [{ type: 'text', value }]
    if (cursor < value.length) {
        nodes.push({ type: 'text', value: value.slice(cursor) })
    }
    return nodes
}

function visit(node: MarkdownNode): void {
    if (!node.children) return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'inlineCode' || child.type === 'code' || child.type === 'link' || child.type === 'linkReference') {
            nextChildren.push(child)
            continue
        }

        if (child.type === 'text' && typeof child.value === 'string') {
            nextChildren.push(...splitAdjacentStrong(child.value))
            continue
        }

        visit(child)
        nextChildren.push(child)
    }
    node.children = nextChildren
}

export default function remarkRepairAdjacentStrong() {
    return (tree: MarkdownNode) => visit(tree)
}
