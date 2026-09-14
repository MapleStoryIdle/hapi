import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    release: { version: '0.20.3' } as { version: string } | null,
}))

vi.mock('@/hooks/queries/useRunnerRelease', () => ({
    useRunnerRelease: () => mocks.release,
}))

import { RunnerUpdateNotice } from './RunnerUpdateNotice'

describe('RunnerUpdateNotice', () => {
    beforeEach(() => {
        mocks.release = { version: '0.20.3' }
        window.history.replaceState({}, '', '/sessions')
    })

    it('shows a manual same-origin install command for an outdated runner', () => {
        render(<RunnerUpdateNotice currentVersion="0.20.2" />)

        expect(screen.getByText(/发现 Runner 新版本 0\.20\.3/)).toBeTruthy()
        expect(screen.getByText(new RegExp(`${window.location.origin}/install\\.sh`))).toBeTruthy()
        expect(screen.getByRole('button', { name: '复制命令' })).toBeTruthy()
    })

    it('does not offer an update action when versions match', () => {
        const view = render(<RunnerUpdateNotice currentVersion="0.20.3" />)

        expect(screen.getByText(/已是最新版本/)).toBeTruthy()
        expect(view.container.querySelector('button')).toBeNull()
    })
})
