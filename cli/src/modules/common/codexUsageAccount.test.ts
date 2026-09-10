import { describe, expect, it } from 'vitest';
import { normalizeCodexUsageAccount } from './codexUsageAccount';

describe('Codex usage identity', () => {
    const oauth = { account: { type: 'chatgpt', email: 'demo@example.com', planType: 'pro', accessToken: 'never-return-this' } };
    it('returns the full account email and does not infer a plan multiplier', () => {
        const result = normalizeCodexUsageAccount(oauth, { config: { model_provider: 'openai' } });
        expect(result).toEqual({ mode: 'oauth', label: 'demo@example.com', plan: 'pro', expiresAt: null, source: 'currentConnection' });
        expect(JSON.stringify(result)).not.toContain('never-return-this');
        expect(normalizeCodexUsageAccount({ account: { ...oauth.account, planType: '20x Pro' } }, { config: { model_provider: 'openai' } }).plan).toBe('20x Pro');
    });
    it('uses API provider auth even with a signed-in Pro account, stripping URL secrets', () => {
        const result = normalizeCodexUsageAccount(oauth, { config: { model_provider: 'proxy', model_providers: { proxy: { requires_openai_auth: false, base_url: 'https://user:secret@example.com/v1?key=secret' } } } });
        expect(result).toEqual({ mode: 'api', label: 'example.com', plan: null, expiresAt: null, source: 'currentConnection' });
    });
    it('does not guess unresolved custom provider authentication', () => {
        expect(normalizeCodexUsageAccount(oauth, { config: { model_provider: 'proxy' } }).mode).toBe('unknown');
        expect(normalizeCodexUsageAccount(oauth, null).mode).toBe('unknown');
        expect(normalizeCodexUsageAccount({ account: { type: 'apiKey' } }, null).mode).toBe('api');
    });
    it('uses the native thread provider instead of the current default provider', () => {
        const config = { config: { model_provider: 'openai', model_providers: { local: { requires_openai_auth: false, base_url: 'http://127.0.0.1:8317/v1' } } } };
        expect(normalizeCodexUsageAccount(oauth, config, 'local')).toMatchObject({ mode: 'api', plan: null, label: '127.0.0.1:8317' });
    });
    it('whitelists a subscription expiry without reading token expiry fields', () => {
        const result = normalizeCodexUsageAccount({ account: {
            ...oauth.account,
            subscriptionExpiresAt: '2026-10-01T00:00:00.000Z',
            accessTokenExpiresAt: '2099-01-01T00:00:00.000Z'
        } }, { config: { model_provider: 'openai' } });
        expect(result.expiresAt).toBe(Date.parse('2026-10-01T00:00:00.000Z'));
    });
});
