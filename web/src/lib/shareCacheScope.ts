const UNKNOWN_NAMESPACE_SCOPE = '__unknown_namespace__'

/**
 * The JWT is verified by the Hub. This reads only its namespace claim so the
 * browser's in-memory share-list cache cannot cross account namespaces.
 */
export function getShareCacheNamespace(token: string): string {
    const payload = token.split('.')[1]
    if (!payload) return UNKNOWN_NAMESPACE_SCOPE

    const base64 = payload
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payload.length / 4) * 4, '=')

    try {
        const binary = globalThis.atob(base64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
        if (
            decoded !== null
            && typeof decoded === 'object'
            && 'ns' in decoded
            && typeof decoded.ns === 'string'
            && decoded.ns.length > 0
        ) {
            return decoded.ns
        }
    } catch {
        // The normal auth flow will reject bad tokens. Keep malformed values in
        // a separate cache bucket until then rather than reusing another user.
    }

    return UNKNOWN_NAMESPACE_SCOPE
}
