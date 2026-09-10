import type { CodexUsageAccount } from '@hapi/protocol/codexUsage';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}
function timestamp(value: unknown): number | null {
    let parsed: number | null = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        parsed = value < 10_000_000_000 ? value * 1000 : value;
    } else if (typeof value === 'string' && value.length > 0 && value.length <= 100) {
        const fromText = Date.parse(value);
        parsed = Number.isNaN(fromText) ? null : fromText;
    }
    return parsed !== null && !Number.isNaN(new Date(parsed).getTime()) ? parsed : null;
}

/** Whitelist only display fields. Never return auth responses, keys or URL credentials. */
export function normalizeCodexUsageAccount(accountResponse: unknown, configResponse: unknown, sessionProvider?: string | null): CodexUsageAccount {
    const account = record(record(accountResponse).account);
    const config = record(record(configResponse).config);
    const providerId = sessionProvider ?? text(config.model_provider ?? config.modelProvider);
    const provider = record(record(config.model_providers ?? config.modelProviders)[providerId ?? 'openai']);
    const unknown: CodexUsageAccount = { mode: 'unknown', label: null, plan: null, expiresAt: null, source: 'currentConnection' };
    const api = account.type === 'apiKey' || provider.requires_openai_auth === false || Boolean(text(provider.env_key));
    if (api) {
        let host: string | null = null;
        try { host = new URL(String(provider.base_url ?? config.openai_base_url)).host || null; } catch { /* No safe address. */ }
        return { ...unknown, mode: 'api', label: host };
    }
    // Unresolved custom providers may use a different auth mechanism from the logged-in account.
    if (providerId && providerId !== 'openai' && provider.requires_openai_auth !== true) return unknown;
    if (account.type !== 'chatgpt' || !Object.keys(config).length) return unknown;
    const expiresAt = timestamp(
        account.planExpiresAt ?? account.plan_expires_at
        ?? account.subscriptionExpiresAt ?? account.subscription_expires_at
    );
    return {
        ...unknown,
        mode: 'oauth',
        label: text(account.email),
        plan: text(account.planType ?? account.plan_type),
        expiresAt
    };
}

const cache = new Map<string, { expires: number; result: Promise<CodexUsageAccount> }>();
export function getCodexUsageAccount(cwd?: string | null, provider?: string | null): Promise<CodexUsageAccount> {
    const key = JSON.stringify([cwd ?? '', provider ?? '']);
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.result;
    const result = (async () => {
        const client = new CodexAppServerClient();
        try {
            await client.connect();
            await client.initialize({ clientInfo: { name: 'hapi-codex-usage', version: '1.0.0' }, capabilities: { experimentalApi: true } });
            const [account, config] = await Promise.all([client.readUsageAccount(), client.readUsageConfig(cwd)]);
            return normalizeCodexUsageAccount(account, config, provider);
        } catch {
            return normalizeCodexUsageAccount(null, null);
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    })();
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + 5 * 60_000, result });
    return result;
}
