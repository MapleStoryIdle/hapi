import { describe, expect, it } from 'vitest';
import {
    buildDefaultModeRequestUserInputConfigArgs,
    DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG
} from './codexFeatureFlags';
import { buildCodexAppServerArgs } from '../codexAppServerClient';

describe('Codex Default-mode user-input feature', () => {
    it('enables the feature through a Codex config override', () => {
        expect(buildDefaultModeRequestUserInputConfigArgs()).toEqual([
            '-c',
            DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG
        ]);
    });

    it('passes the override when starting the app server', () => {
        expect(buildCodexAppServerArgs()).toEqual([
            'app-server',
            '-c',
            DEFAULT_MODE_REQUEST_USER_INPUT_CONFIG
        ]);
    });
});
