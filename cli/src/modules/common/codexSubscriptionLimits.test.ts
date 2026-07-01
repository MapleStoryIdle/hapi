import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from '@/codex/appServerTypes';
import {
    CODEX_SUBSCRIPTION_LIMITS_MIN_QUERY_INTERVAL_MS,
    readCodexRateLimitsWithMinimumIntervalForTests,
    resetCodexSubscriptionLimitsCacheForTests,
    selectCodexRateLimitSnapshotForTests
} from './codexSubscriptionLimits';

function snapshot(limitId: string, limitName: string, usedPercent: number): RateLimitSnapshot {
    return {
        limitId,
        limitName,
        primary: {
            usedPercent,
            windowDurationMins: 300,
            resetsAt: 1
        },
        secondary: null,
        planType: 'pro'
    };
}

function response(usedPercent: number): GetAccountRateLimitsResponse {
    return {
        rateLimits: snapshot('codex', 'Codex', usedPercent),
        rateLimitsByLimitId: null
    };
}

beforeEach(() => {
    resetCodexSubscriptionLimitsCacheForTests();
});

describe('Codex subscription limit snapshot selection', () => {
    it('uses the model-specific limitName before the generic codex bucket', () => {
        // Verifies Spark sessions read the Spark quota instead of the generic Codex quota.
        const generic = snapshot('codex', 'Codex', 80);
        const spark = snapshot('codex_bengalfox', 'GPT-5.3-Codex-Spark', 12);

        const selected = selectCodexRateLimitSnapshotForTests(
            generic,
            {
                codex: generic,
                codex_bengalfox: spark
            },
            'gpt-5.3-codex-spark'
        );

        expect(selected).toBe(spark);
    });

    it('falls back to the generic codex bucket when no model-specific bucket matches', () => {
        // Verifies regular Codex models keep using the existing generic quota bucket.
        const generic = snapshot('codex', 'Codex', 80);
        const spark = snapshot('codex_bengalfox', 'GPT-5.3-Codex-Spark', 12);

        const selected = selectCodexRateLimitSnapshotForTests(
            generic,
            {
                codex: generic,
                codex_bengalfox: spark
            },
            'gpt-5.5'
        );

        expect(selected).toBe(generic);
    });
});

describe('Codex subscription limit query interval', () => {
    it('reuses the cached response within the five-minute minimum interval', async () => {
        // Avoids hitting Codex app-server after every assistant turn in the same window.
        let now = 1_000;
        const firstResponse = response(20);
        const fetcher = vi.fn(async () => firstResponse);

        const first = await readCodexRateLimitsWithMinimumIntervalForTests({
            fetcher,
            now: () => now
        });
        now += CODEX_SUBSCRIPTION_LIMITS_MIN_QUERY_INTERVAL_MS - 1;
        const second = await readCodexRateLimitsWithMinimumIntervalForTests({
            fetcher,
            now: () => now
        });

        expect(first.response).toBe(firstResponse);
        expect(second.response).toBe(firstResponse);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('refreshes after the five-minute minimum interval has elapsed', async () => {
        // Confirms the cache is a throttle, not a permanent session snapshot.
        let now = 1_000;
        const firstResponse = response(20);
        const secondResponse = response(35);
        const fetcher = vi.fn()
            .mockResolvedValueOnce(firstResponse)
            .mockResolvedValueOnce(secondResponse);

        await readCodexRateLimitsWithMinimumIntervalForTests({
            fetcher,
            now: () => now
        });
        now += CODEX_SUBSCRIPTION_LIMITS_MIN_QUERY_INTERVAL_MS;
        const refreshed = await readCodexRateLimitsWithMinimumIntervalForTests({
            fetcher,
            now: () => now
        });

        expect(refreshed.response).toBe(secondResponse);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('shares one in-flight Codex rate-limit request across concurrent callers', async () => {
        // Multiple browser refreshes should not spawn parallel Codex app-server reads.
        let resolveFetch!: (value: GetAccountRateLimitsResponse) => void;
        const fetcher = vi.fn(() => new Promise<GetAccountRateLimitsResponse>((resolve) => {
            resolveFetch = resolve;
        }));

        const firstPromise = readCodexRateLimitsWithMinimumIntervalForTests({ fetcher });
        const secondPromise = readCodexRateLimitsWithMinimumIntervalForTests({ fetcher });
        const sharedResponse = response(42);
        resolveFetch(sharedResponse);

        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        expect(first.response).toBe(sharedResponse);
        expect(second.response).toBe(sharedResponse);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});
