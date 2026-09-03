/**
 * Enable Codex's experimental user-input tool in Default collaboration mode.
 *
 * Remote SHAPI sessions use a temporary CODEX_HOME for their delegated token,
 * so they do not inherit a user's local config.toml feature settings.
 */
export const DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE = 'default_mode_request_user_input';

export const DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG =
    `features.${DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE}=true`;

export function buildDefaultModeRequestUserInputConfigArgs(): string[] {
    return ['-c', DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG];
}
