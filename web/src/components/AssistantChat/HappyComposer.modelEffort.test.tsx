import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
    ModelEffortSettingsSection,
    extractLeadingSkillForComposer,
    getComposerTextWithSelectedSkill
} from './HappyComposer';

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.variant' ? 'Variant' : key
    })
}));

describe('ModelEffortSettingsSection', () => {
    it('renders Cursor variant choices and marks the selected variant', () => {
        render(
            <ModelEffortSettingsSection
                agentFlavor="cursor"
                options={[
                    { value: 'composer-2.5', label: 'Composer 2.5' },
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' }
                ]}
                selectedValue="composer-2.5"
                controlsDisabled={false}
                onChange={() => {}}
            />
        );

        expect(screen.getByText('Variant')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Composer 2.5$/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Composer 2.5 Fast/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Composer 2.5$/ }).innerHTML).toContain('bg-[var(--app-link)]');
    });
});

describe('composer selected skill helpers', () => {
    /**
     * Selected skills render outside the textarea, but the outgoing payload
     * still needs the historical `$skill` directive prefix for the runner.
     */
    it('prepends the selected skill only when the text does not already start with it', () => {
        expect(getComposerTextWithSelectedSkill('hello', 'grill-me')).toBe('$grill-me hello');
        expect(getComposerTextWithSelectedSkill('  hello', 'grill-me')).toBe('$grill-me hello');
        expect(getComposerTextWithSelectedSkill('$grill-me hello', 'grill-me')).toBe('$grill-me hello');
    });

    /**
     * Send-error restore receives the real outbound text. Pull the leading
     * skill back into chip state so textarea styling stays normal on retry.
     */
    it('extracts a leading skill directive for composer restore', () => {
        const restored = extractLeadingSkillForComposer(
            '$grill-me sharpen this',
            new Map([['grill-me', { name: 'grill-me', description: 'Interview' }]])
        );

        expect(restored).toEqual({
            skill: { name: 'grill-me', description: 'Interview' },
            text: 'sharpen this'
        });
    });
});
