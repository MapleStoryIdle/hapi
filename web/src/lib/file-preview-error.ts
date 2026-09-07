import { ApiError } from '@/api/client'

export type FilePreviewIssue = 'missing' | 'denied' | 'tooLarge' | 'invalid' | 'unsupported' | 'offline' | 'unavailable' | 'empty'

export class FilePreviewError extends Error {
    constructor(public readonly issue: FilePreviewIssue) {
        super(issue)
    }
}

/** Backend details are used for classification only, never rendered as user copy. */
export function classifyFilePreviewError(error: unknown): FilePreviewIssue {
    if (error instanceof FilePreviewError) return error.issue
    const status = error instanceof ApiError ? error.status : undefined
    let message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    if (error instanceof ApiError && error.body) {
        try {
            const body: unknown = JSON.parse(error.body)
            if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
                message += ` ${body.error}`
            }
        } catch { /* A proxy HTML error page is not useful for file classification. */ }
    }
    if (status === 401 || status === 403 || /\b(EACCES|EPERM)\b|permission denied|forbidden|HTTP (401|403)|path traversal|outside.*(directory|workspace)|access denied/i.test(message)) return 'denied'
    if (/\bENOENT\b|no such file|file not found/i.test(message)) return 'missing'
    if (status === 413 || /\bEFBIG\b|too large|exceeds.*(size|limit)|HTTP 413/i.test(message)) return 'tooLarge'
    if (/\bEISDIR\b|is a directory|unsupported.*(file|format)|binary file/i.test(message)) return 'unsupported'
    if (/invalid.*base64|InvalidCharacterError|corrupt/i.test(message)) return 'invalid'
    if (status === 408 || status === 504 || /offline|not connected|disconnected|timed?\s*out|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|failed to fetch|network error|load failed/i.test(message)) return 'offline'
    // A bare 404/502 may refer to the session, runner or route, not a missing file.
    return 'unavailable'
}
