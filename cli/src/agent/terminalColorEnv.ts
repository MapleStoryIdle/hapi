/**
 * Runner-started agent processes use piped stdio, so child commands often
 * disable ANSI automatically. Advertise color support without allocating a
 * PTY; structured agent protocols remain non-interactive.
 */
export function configureNonInteractiveTerminalColors(env: NodeJS.ProcessEnv = process.env): void {
    env.TERM = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color';
    env.COLORTERM ||= 'truecolor';
    env.FORCE_COLOR = '1';
    env.CLICOLOR_FORCE = '1';
    delete env.NO_COLOR;
}
