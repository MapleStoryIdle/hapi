import '@testing-library/jest-dom/vitest'

function installMemoryLocalStorage(): void {
    const store = new Map<string, string>()
    const memoryLocalStorage: Storage = {
        get length() {
            return store.size
        },
        clear() {
            store.clear()
        },
        getItem(key: string) {
            return store.get(key) ?? null
        },
        key(index: number) {
            return Array.from(store.keys())[index] ?? null
        },
        removeItem(key: string) {
            store.delete(key)
        },
        setItem(key: string, value: string) {
            store.set(key, String(value))
        }
    }

    Object.defineProperty(globalThis, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
    Object.defineProperty(window, 'localStorage', {
        value: memoryLocalStorage,
        configurable: true
    })
}

try {
    const storage = globalThis.localStorage
    if (
        typeof storage?.getItem !== 'function'
        || typeof storage.setItem !== 'function'
        || typeof storage.removeItem !== 'function'
        || typeof storage.clear !== 'function'
    ) {
        installMemoryLocalStorage()
    }
} catch {
    installMemoryLocalStorage()
}

if (!('IntersectionObserver' in globalThis)) {
    class MockIntersectionObserver implements IntersectionObserver {
        readonly root = null
        readonly rootMargin = ''
        readonly thresholds = []

        disconnect() {}
        observe() {}
        takeRecords(): IntersectionObserverEntry[] { return [] }
        unobserve() {}
    }

    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
    Object.defineProperty(window, 'IntersectionObserver', {
        value: MockIntersectionObserver,
        configurable: true
    })
}

// assistant-ui measures its thread root on mount. jsdom has no layout engine,
// so a no-op observer is sufficient for component tests that exercise the
// normal conversation renderer.
if (!('ResizeObserver' in globalThis)) {
    class MockResizeObserver implements ResizeObserver {
        disconnect() {}
        observe() {}
        unobserve() {}
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
        value: MockResizeObserver,
        configurable: true
    })
    Object.defineProperty(window, 'ResizeObserver', {
        value: MockResizeObserver,
        configurable: true
    })
}

if (typeof HTMLElement.prototype.scrollTo !== 'function') {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
        value(options: ScrollToOptions | number, top?: number) {
            if (typeof options === 'number') {
                this.scrollTop = top ?? 0
                return
            }
            this.scrollTop = options.top ?? this.scrollTop
            this.scrollLeft = options.left ?? this.scrollLeft
        },
        configurable: true
    })
}

if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: (query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent() { return false },
        }),
    })
}
