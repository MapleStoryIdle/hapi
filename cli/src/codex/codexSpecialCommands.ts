import type { ReviewTarget } from './appServerTypes';

const REVIEW_USAGE = 'Usage: /review [--uncommitted|--base <branch>|--commit <sha> [--title <title>]|instructions]';

export type CodexSpecialCommand =
    | { type: 'clear' | 'compact' }
    | { type: 'review'; target: ReviewTarget }
    | { type: 'invalid'; command: 'clear' | 'compact' | 'review'; message: string }
    | { type: null };

function tokenizeReviewArgs(input: string): string[] | null {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const char of input) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === '\\') {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }

    if (escaping) {
        current += '\\';
    }
    if (quote) {
        return null;
    }
    if (current) {
        tokens.push(current);
    }
    return tokens;
}

function parseReviewTarget(rest: string): { target?: ReviewTarget; error?: string } {
    if (!rest) {
        return { target: { type: 'uncommittedChanges' } };
    }

    const tokens = tokenizeReviewArgs(rest);
    if (!tokens) {
        return { error: 'Unclosed quote in /review arguments' };
    }
    if (tokens.length === 0) {
        return { target: { type: 'uncommittedChanges' } };
    }
    if (!tokens[0]?.startsWith('-')) {
        return { target: { type: 'custom', instructions: rest } };
    }

    let target: ReviewTarget | null = null;
    let title: string | null = null;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        switch (token) {
            case '--uncommitted':
                if (target) return { error: REVIEW_USAGE };
                target = { type: 'uncommittedChanges' };
                break;
            case '--base': {
                if (target) return { error: REVIEW_USAGE };
                const branch = tokens[index + 1];
                if (!branch || branch.startsWith('--')) return { error: REVIEW_USAGE };
                target = { type: 'baseBranch', branch };
                index += 1;
                break;
            }
            case '--commit': {
                if (target) return { error: REVIEW_USAGE };
                const sha = tokens[index + 1];
                if (!sha || sha.startsWith('--')) return { error: REVIEW_USAGE };
                target = { type: 'commit', sha, title };
                index += 1;
                break;
            }
            case '--title': {
                const value = tokens[index + 1];
                if (!value || value.startsWith('--')) return { error: REVIEW_USAGE };
                title = value;
                if (target?.type === 'commit') {
                    target = { type: 'commit', sha: target.sha, title };
                }
                index += 1;
                break;
            }
            default:
                return { error: REVIEW_USAGE };
        }
    }

    if (!target) {
        return { error: REVIEW_USAGE };
    }
    if (title !== null && target.type !== 'commit') {
        return { error: '--title can only be used with --commit' };
    }
    return { target };
}

export function parseCodexSpecialCommand(message: string): CodexSpecialCommand {
    const trimmed = message.trim();
    if (trimmed === '/clear') {
        return { type: 'clear' };
    }
    if (trimmed === '/compact') {
        return { type: 'compact' };
    }
    if (trimmed.startsWith('/clear ')) {
        return {
            type: 'invalid',
            command: 'clear',
            message: '/clear does not accept arguments'
        };
    }
    if (trimmed.startsWith('/compact ')) {
        return {
            type: 'invalid',
            command: 'compact',
            message: '/compact does not accept arguments'
        };
    }
    if (trimmed === '/review' || trimmed.startsWith('/review ')) {
        const rest = trimmed.slice('/review'.length).trim();
        const parsed = parseReviewTarget(rest);
        if (parsed.error || !parsed.target) {
            return {
                type: 'invalid',
                command: 'review',
                message: parsed.error ?? REVIEW_USAGE
            };
        }
        return { type: 'review', target: parsed.target };
    }
    return { type: null };
}
