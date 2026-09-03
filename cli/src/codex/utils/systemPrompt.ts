/**
 * Codex-specific developer prompt for SHAPI sessions.
 *
 * Injected into both local CLI and remote App Server sessions.
 */

import { trimIdent } from '@/utils/trimIdent';
import { buildSessionCitationSteerInstruction } from '@hapi/protocol/sessionCitation'

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
    ${buildSessionCitationSteerInstruction({
        inspectTool: 'functions.hapi__inspect_peer',
        pingTool: 'functions.hapi__ping_peer',
        listPeersTool: 'functions.hapi__list_peers'
    })}
`);

const REQUEST_USER_INPUT_INSTRUCTION = trimIdent(`
    ## Structured user decisions
    When the native request_user_input tool is available in the active Codex mode, use it before asking the user for a decision, confirmation, clarification, or choice that blocks progress. Do not ask the same decision first in normal assistant text.
    Prefer 2–4 clear, mutually exclusive options with short labels and descriptions. Do not add an Other option: SHAPI provides a separate Other control for free-form answers.
    Do not interrupt for routine low-risk assumptions; make a reasonable assumption and continue. Do not use request_user_input for sandbox, command, file-edit, or other tool-permission approvals: use the normal permission flow for those.
    If request_user_input is unavailable, ask one concise plain-text question instead of pretending a choice dialog exists.
`);

/**
 * The SHAPI developer prompt injected into Codex local and app-server sessions.
 */
export const codexSystemPrompt = `${TITLE_INSTRUCTION}\n\n${REQUEST_USER_INPUT_INSTRUCTION}`;
