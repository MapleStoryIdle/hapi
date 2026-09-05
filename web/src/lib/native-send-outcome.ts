import { ApiError } from '@/api/client'

// These codes are emitted before accepting a prompt, or after a confirmed
// failure to start its sender. Silence/network errors are never rejection.
const REJECTED_CODES = new Set([
    'invalid_message', 'invalid_client_message_id', 'session_not_found',
    'workspace_unavailable', 'not_native_session', 'queue_full',
    'external_writer_active', 'launch_failed'
])

export function isConfirmedNativeSendRejectionCode(code: string | null | undefined): boolean {
    return typeof code === 'string' && REJECTED_CODES.has(code)
}

export function isConfirmedNativeSendRejection(error: unknown, options: { recovery?: boolean } = {}): boolean {
    // Inspect structured codes first: e.g. launch_failed may use HTTP 502.
    return error instanceof ApiError && (isConfirmedNativeSendRejectionCode(error.code)
        // On initial submission this means the session is being archived.
        // A recovery can also be busy because the original is already queued.
        || (error.code === 'session_busy' && !options.recovery))
}
