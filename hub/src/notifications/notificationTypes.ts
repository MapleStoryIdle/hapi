import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'

export type TaskNotification = {
    summary: string
    status?: string
}

/**
 * Claude emits task notifications for background/subagent work. A successful
 * completion is informational inside the transcript, while failures need an
 * out-of-band alert.
 */
export function isTaskNotificationFailure(notification: TaskNotification): boolean {
    const status = notification.status?.trim().toLowerCase()
    return status === 'failed'
        || status === 'error'
        || status === 'killed'
        || status === 'aborted'
}

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
