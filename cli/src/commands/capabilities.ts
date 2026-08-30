/**
 * 供脚本、IDE 集成和 Agent 读取的 CLI 功能目录。
 *
 * Human-oriented `--help` 会变动排版；自动化请使用 `hapi --hapi-capabilities`
 * 或子命令的 `--hapi-help-json`，其 JSON 字段是稳定的机器接口。
 */
export const HAPI_CLI_CAPABILITIES = {
    schemaVersion: 1,
    commands: {
        codex: {
            subcommands: {
                resume: {
                    args: ['sessionId'],
                    description: 'Resume a native Codex thread in a HAPI session.'
                },
                fork: {
                    args: ['sourceSessionId'],
                    description: 'Fork a native Codex thread while preserving its native history, model and reasoning configuration.',
                    sourceRunnerAffinity: 'selected_runner_owns_transcript',
                    localTranscriptRpc: true
                }
            },
            options: ['--permission-mode', '--model', '--model-reasoning-effort', '--service-tier', '--started-by']
        },
        'inspect-peer': {
            sideEffects: 'read_only',
            args: ['sessionIdPrefix'],
            options: ['--limit'],
            acceptsSessionCitation: true
        },
        'ping-peer': {
            sideEffects: 'resume_target_and_send_message',
            args: ['sessionIdPrefix', 'message'],
            options: ['--list', '--message-file', '--wait'],
            acceptsSessionCitation: true,
            rejectsCallerSession: true
        },
        share: {
            subcommands: { publish: { args: ['relativeFile'], options: ['--expires'] }, revoke: { args: ['shareId'] } },
            sideEffects: 'upload_selected_local_file'
        },
        mcp: {
            tools: ['change_title', 'display_image', 'verify_ssh_server_candidate', 'list_peers', 'inspect_peer', 'ping_peer']
        }
    }
} as const

export type HapiCliCommandName = keyof typeof HAPI_CLI_CAPABILITIES.commands

export function getHapiCliCommandCapabilities(command: HapiCliCommandName): unknown {
    return {
        schemaVersion: HAPI_CLI_CAPABILITIES.schemaVersion,
        command,
        ...HAPI_CLI_CAPABILITIES.commands[command]
    }
}

export function printHapiCliCapabilities(command?: HapiCliCommandName): void {
    console.log(JSON.stringify(command ? getHapiCliCommandCapabilities(command) : HAPI_CLI_CAPABILITIES))
}
