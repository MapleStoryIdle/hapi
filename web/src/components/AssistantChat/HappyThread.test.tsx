import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    ScrollToBottomButton,
    captureScrollAnchor,
    getThreadContentPadding,
    getPullToLoadOlderIndicator,
    shouldShowHistoryLoadingNotice,
    getScrollIntent,
    locateOutlineTargetMessage,
    restoreScrollAnchor,
    shouldCancelInitialScrollSettling,
    shouldCancelLatestMessageFollow,
    shouldEnableTopSentinelAutoLoad,
    shouldFollowBottomInsetChange,
    shouldWaitForDeferredHistoryRender,
    shouldHideScrollToBottomButton,
    shouldLoadOlderFromTopWheel,
} from '@/components/AssistantChat/HappyThread'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]

function rect(values: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>): DOMRect {
    return {
        left: 0,
        right: 300,
        width: 300,
        height: values.bottom - values.top,
        x: 0,
        y: values.top,
        toJSON: () => ({}),
        ...values
    } as DOMRect
}

function renderPanel(props: Partial<ComponentProps<typeof ConversationOutlinePanel>> = {}) {
    return render(
        <I18nProvider>
            <ConversationOutlinePanel
                title="project"
                items={outlineItems}
                hasMoreMessages={false}
                isLoadingMoreMessages={false}
                onLoadMore={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('ConversationOutlinePanel', () => {
    it('renders outline items and selects an item', () => {
        const onSelect = vi.fn()
        renderPanel({ onSelect })

        fireEvent.click(screen.getByText('Implement the panel'))

        expect(onSelect).toHaveBeenCalledWith(outlineItems[0])
    })

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('renders an empty state', () => {
        renderPanel({ items: [] })

        expect(screen.getByText('No outline items in loaded messages')).toBeInTheDocument()
    })
})

describe('ScrollToBottomButton', () => {
    it('shows a back-to-bottom control when the thread is away from bottom', () => {
        const { container } = render(
            <I18nProvider>
                <ScrollToBottomButton count={0} visible={true} onClick={vi.fn()} />
            </I18nProvider>
        )

        expect(container.querySelector('button')?.style.bottom).toBe('0px')
        expect(container.querySelector('button')?.style.right).toContain('var(--content-max-w')
        expect(container.querySelector('button')?.className).not.toContain('animate-bounce-in')
        expect(container.querySelector('button span')?.className).toContain('animate-bounce-in')
    })

    it('moves above the bottom accessory when git diff summary is visible', () => {
        const { container } = render(
            <I18nProvider>
                <ScrollToBottomButton
                    count={0}
                    visible={true}
                    bottomInset={120}
                    bottomAccessoryVisible={true}
                    onClick={vi.fn()}
                />
            </I18nProvider>
        )

        expect(container.querySelector('button')?.style.bottom).toBe('128px')
    })

    it('keeps the control above the mobile bottom safe area', () => {
        const { container } = render(
            <I18nProvider>
                <ScrollToBottomButton count={0} visible={true} bottomInset={120} bottomSafeAreaInset onClick={vi.fn()} />
            </I18nProvider>
        )

        expect(container.querySelector('button')?.style.bottom).toBe(
            'calc(120px + var(--app-safe-area-bottom))'
        )
    })

    it('stays hidden at bottom when there are no pending messages', () => {
        const { container } = render(
            <I18nProvider>
                <ScrollToBottomButton count={0} visible={false} onClick={vi.fn()} />
            </I18nProvider>
        )

        expect(container.textContent).toBe('')
    })

    it('can be suppressed while a bottom accessory popover is open', () => {
        const { container } = render(
            <I18nProvider>
                <ScrollToBottomButton count={3} visible={true} hidden={true} onClick={vi.fn()} />
            </I18nProvider>
        )

        expect(container.textContent).toBe('')
    })
})

describe('thread endpoint insets', () => {
    it('keeps the initial messages below the notch and title controls while allowing scroll-under', () => {
        const contentPadding = getThreadContentPadding({ topInset: 62 })

        // The viewport remains edge-to-edge. The content's initial spacer
        // clears the installed-PWA safe area and title controls, then scrolls
        // naturally under the transparent header.
        expect(contentPadding.paddingTop).toBe('calc(var(--app-safe-area-top) + 62px)')
        expect(contentPadding.paddingBottom).toBeUndefined()
    })

    it('keeps the latest message above an iPhone composer without duplicating its safe area', () => {
        // The measured overlay already contains HappyComposer's bottom safe
        // area (e.g. input + 34px home-indicator inset on a current iPhone).
        const padding = getThreadContentPadding({ bottomInset: 104 })

        expect(padding.paddingBottom).toBe('116px')
    })
})

describe('bottom inset follow behavior', () => {
    it('keeps a just-sent thread aligned after the composer height changes', () => {
        expect(shouldFollowBottomInsetChange({
            autoScrollEnabled: true,
            atBottom: true,
            restoringScroll: false
        })).toBe(true)
    })

    it('does not pull a manually scrolled or anchor-restoring thread to the composer', () => {
        expect(shouldFollowBottomInsetChange({
            autoScrollEnabled: false,
            atBottom: false,
            restoringScroll: false
        })).toBe(false)
        expect(shouldFollowBottomInsetChange({
            autoScrollEnabled: true,
            atBottom: true,
            restoringScroll: true
        })).toBe(false)
    })
})

describe('latest-message follow behavior', () => {
    it('does not stop following because layout or streaming moved the viewport', () => {
        expect(shouldCancelLatestMessageFollow({
            followingLatest: true,
            isAtBottom: false,
            isScrollingUp: false,
            userInitiated: false
        })).toBe(false)
    })

    it('stops following only when the user scrolls away from the bottom', () => {
        expect(shouldCancelLatestMessageFollow({
            followingLatest: true,
            isAtBottom: false,
            isScrollingUp: true,
            userInitiated: true
        })).toBe(true)
        expect(shouldCancelLatestMessageFollow({
            followingLatest: true,
            isAtBottom: true,
            isScrollingUp: true,
            userInitiated: true
        })).toBe(false)
        expect(shouldCancelLatestMessageFollow({
            followingLatest: true,
            isAtBottom: false,
            isScrollingUp: false,
            userInitiated: true
        })).toBe(false)
    })
})

describe('pull-to-load-older helpers', () => {
    it('keeps the scroll anchor until deferred history reaches the DOM', () => {
        expect(shouldWaitForDeferredHistoryRender({
            hasPendingRestore: true,
            baselineSourceMessagesVersion: 8,
            sourceMessagesVersion: 9,
            renderedMessagesVersion: 8,
        })).toBe(true)

        expect(shouldWaitForDeferredHistoryRender({
            hasPendingRestore: true,
            baselineSourceMessagesVersion: 8,
            sourceMessagesVersion: 9,
            renderedMessagesVersion: 9,
        })).toBe(false)
    })

    it('releases the scroll anchor when pagination returns no new rows', () => {
        expect(shouldWaitForDeferredHistoryRender({
            hasPendingRestore: true,
            baselineSourceMessagesVersion: 8,
            sourceMessagesVersion: 8,
            renderedMessagesVersion: 8,
        })).toBe(false)
    })

    it('loads older messages when wheel-up hits the top edge', () => {
        expect(shouldLoadOlderFromTopWheel({
            scrollTop: 0,
            deltaY: -24
        })).toBe(true)
    })

    it('ignores wheel events away from the top edge', () => {
        expect(shouldLoadOlderFromTopWheel({
            scrollTop: 12,
            deltaY: -24
        })).toBe(false)
    })

    it('ignores downward and mostly-horizontal wheel movement', () => {
        expect(shouldLoadOlderFromTopWheel({
            scrollTop: 0,
            deltaY: 24
        })).toBe(false)
        expect(shouldLoadOlderFromTopWheel({
            scrollTop: 0,
            deltaY: -8,
            deltaX: 24
        })).toBe(false)
    })

    it('keeps top-sentinel auto loading when desktop input is available as any pointer', () => {
        const matchMedia = vi.fn((query: string) => ({
            matches: query === '(any-hover: hover) and (any-pointer: fine)'
        } as MediaQueryList))

        expect(shouldEnableTopSentinelAutoLoad(matchMedia)).toBe(true)
        expect(matchMedia).toHaveBeenCalledWith('(any-hover: hover) and (any-pointer: fine)')
    })

    it('disables top-sentinel auto loading on touch-only devices', () => {
        const matchMedia = vi.fn(() => ({
            matches: false
        } as MediaQueryList))

        expect(shouldEnableTopSentinelAutoLoad(matchMedia)).toBe(false)
    })

    it('stays idle when the gesture is unavailable', () => {
        expect(getPullToLoadOlderIndicator({
            enabled: false,
            loading: false,
            distancePx: 120
        })).toEqual({
            phase: 'idle',
            progress: 0,
            offset: 0
        })
    })

    it('reports pulling before the release threshold', () => {
        expect(getPullToLoadOlderIndicator({
            enabled: true,
            loading: false,
            distancePx: 36,
            thresholdPx: 72,
            maxOffsetPx: 48
        })).toEqual({
            phase: 'pulling',
            progress: 0.5,
            offset: 20.88
        })
    })

    it('reports ready once the release threshold is reached', () => {
        expect(getPullToLoadOlderIndicator({
            enabled: true,
            loading: false,
            distancePx: 96,
            thresholdPx: 72,
            maxOffsetPx: 48
        })).toEqual({
            phase: 'ready',
            progress: 1,
            offset: 48
        })
    })

    it('keeps the loading state visible while older messages load', () => {
        expect(getPullToLoadOlderIndicator({
            enabled: false,
            loading: true,
            distancePx: 0
        })).toMatchObject({
            phase: 'loading',
            progress: 1
        })
    })

    it('shows only the pull indicator while pull-to-load is fetching older messages', () => {
        expect(shouldShowHistoryLoadingNotice({
            isLoadingOlder: true,
            isLoadingNewer: false,
            loadLocked: true,
            showRestoredNotice: false,
            pullToLoadLoading: true
        })).toBe(false)
        expect(shouldShowHistoryLoadingNotice({
            isLoadingOlder: true,
            isLoadingNewer: false,
            loadLocked: true,
            showRestoredNotice: false,
            pullToLoadLoading: false
        })).toBe(true)
        expect(shouldShowHistoryLoadingNotice({
            isLoadingOlder: false,
            isLoadingNewer: true,
            loadLocked: false,
            showRestoredNotice: false,
            pullToLoadLoading: true
        })).toBe(true)
    })
})

describe('shouldHideScrollToBottomButton', () => {
    it('keeps the plain back-to-bottom button visible while a bottom accessory is only collapsed', () => {
        expect(shouldHideScrollToBottomButton({
            bottomAccessoryVisible: true,
            pendingCount: 0
        })).toBe(false)
    })

    it('keeps the new-message button visible even with a bottom accessory', () => {
        expect(shouldHideScrollToBottomButton({
            bottomAccessoryVisible: true,
            pendingCount: 2
        })).toBe(false)
    })

    it('hides the button while a bottom accessory popover is expanded', () => {
        expect(shouldHideScrollToBottomButton({
            bottomAccessoryExpanded: true,
            bottomAccessoryVisible: true,
            pendingCount: 2
        })).toBe(true)
    })
})

describe('scroll anchor helpers', () => {
    it('captures the first visible message relative to the viewport', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        viewport.className = 'viewport'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'second-message',
            topOffset: 20,
            element: second,
        })

        viewport.remove()
    })

    it('captures the last visible message bottom for older-page restoration', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 80, bottom: 180 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 540 }))

        expect(captureScrollAnchor(viewport, 'bottom')).toEqual({
            id: 'second-message',
            bottomOffset: 40,
            element: second,
        })

        viewport.remove()
    })

    it('keeps automatic following paused after upward motion near the bottom', () => {
        expect(getScrollIntent({
            scrollTop: 690,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 12,
            isAtBottom: false,
            isScrollingUp: true
        })
    })

    it('does not classify downward movement as upward manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 0,
            isAtBottom: true,
            isScrollingUp: false
        })
    })

    it('cancels initial scroll settling when the user scrolls up away from the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 520,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 182,
            isScrollingUp: true
        })
        expect(shouldCancelInitialScrollSettling(intent)).toBe(true)
    })

    it('keeps initial scroll settling for negligible movement at the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 0,
            isScrollingUp: false
        })
        expect(shouldCancelInitialScrollSettling(intent)).toBe(false)
    })

    it('restores the captured message to the same viewport offset', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 260 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', topOffset: 30 })).toBe(true)
        expect(viewport.scrollTop).toBe(250)

        viewport.remove()
    })

    it('restores a bottom anchor when older content expands a joined message', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 40, bottom: 700 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', bottomOffset: 40 })).toBe(true)
        expect(viewport.scrollTop).toBe(360)

        viewport.remove()
    })

})

describe('outline target loading', () => {
    it('loads older messages through the scroll-preserving wrapper until the target appears', async () => {
        const loadOlderPreservingScroll = vi.fn<() => Promise<boolean>>()
        let loadCount = 0
        loadOlderPreservingScroll.mockImplementation(async () => {
            loadCount += 1
            return true
        })

        const findTarget = vi.fn((anchorId: string) => {
            if (anchorId !== 'hapi-message-user-text:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user-text:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })
})
