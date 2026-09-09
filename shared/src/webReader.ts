/** Data-only reader document: no executable HTML, attributes, styles or forms. */
export const readerTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'ul', 'ol', 'li', 'blockquote', 'strong', 'em', 'br', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'caption', 'tr', 'th', 'td', 'a', 'img', 'figure', 'figcaption'] as const
export type ReaderNode = string | { tag: typeof readerTags[number]; children: ReaderNode[]; href?: string; src?: string; alt?: string; width?: number; height?: number; colSpan?: number; rowSpan?: number }
export type WebReaderResponse = { mode: 'embed' } | { mode: 'blocked' } | { mode: 'readonly'; title: string; url: string; content: ReaderNode[] }
