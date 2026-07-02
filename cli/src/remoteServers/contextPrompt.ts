import type { RemoteServerSnapshot } from '@hapi/protocol/types'

function singleLine(value: string): string {
    return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function quoted(value: string): string {
    return JSON.stringify(singleLine(value))
}

export function formatMessageWithRemoteServerContext(
    text: string,
    remoteServer: RemoteServerSnapshot | null | undefined
): string {
    if (!remoteServer) {
        return text
    }

    const lines = [
        '<hapi_remote_server_context>',
        'The user selected this HAPI remote server context for this turn.',
        `Name: ${quoted(remoteServer.name)}`,
        `Alias: ${quoted(remoteServer.alias)}`,
        `Workspace: ${quoted(remoteServer.workspace)}`,
        `SSH target: ${quoted(`${remoteServer.user}@${remoteServer.host}`)}`,
        `SSH port: ${remoteServer.port}`,
        `Source project: ${quoted(remoteServer.sourceProject)}`,
        remoteServer.tags.length > 0 ? `Tags: ${JSON.stringify(remoteServer.tags.map(singleLine).filter(Boolean))}` : null,
        'When the task requires operating on the selected server, use ssh/scp/rsync targeting this server. Do not treat it as the local workspace.',
        '</hapi_remote_server_context>',
        '',
        text
    ].filter((line): line is string => line !== null)

    return lines.join('\n')
}
