/**
 * Codex-specific system prompt for local mode.
 *
 * This prompt instructs Codex to call the hapi__change_title function
 * to set appropriate chat session titles.
 */

import { trimIdent } from '@/utils/trimIdent';

/**
 * Title instruction for Codex to call the hapi MCP tool.
 * Note: Codex exposes MCP tools under the `functions.` namespace,
 * so the tool is called as `functions.hapi__change_title`.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Use the title tool sparingly. For a new chat, call it once after the user's initial request is clear, and set a concise task title.
    Prefer calling functions.hapi__change_title.
    If that exact tool name is unavailable, call an equivalent alias such as hapi__change_title, mcp__hapi__change_title, or hapi_change_title.
    Do not rename the chat for routine progress, substeps, implementation details, or a slightly better wording.
    Rename only when the user's primary objective changes substantially and the existing title would be misleading.
    When you create or find a local image file that the user should see, call functions.hapi__display_image with the image path. If that exact tool name is unavailable, use an equivalent alias such as hapi__display_image, mcp__hapi__display_image, or hapi_display_image.
    When an ssh, scp, or rsync command succeeds against a remote SSH server, call functions.hapi__verify_ssh_server_candidate with the user, host, port, command kind, optional SSH config Host alias, and optional tool call id. If that exact tool name is unavailable, use an equivalent alias such as hapi__verify_ssh_server_candidate, mcp__hapi__verify_ssh_server_candidate, or hapi_verify_ssh_server_candidate. Do not include or persist the full command.
`);

/**
 * The system prompt to inject via developer_instructions in local mode.
 */
export const codexSystemPrompt = TITLE_INSTRUCTION;
