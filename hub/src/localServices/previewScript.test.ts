import { expect, it } from 'bun:test'
import { rewritePreviewScript } from './previewScript'

it('adapts browser globals without rewriting route strings or shadowed variables', () => {
    const source = `const base='/studio/';const path=window.location.pathname;const origin=location.origin;const globalPath=globalThis.location.pathname;function scoped(window){return window.location};export const text='window.location';`
    const result = rewritePreviewScript(source)
    expect(result).toContain('"/studio/"')
    expect(result).toContain('globalThis.__SHAPI_PREVIEW_WINDOW__.location.pathname')
    expect(result).toContain('globalThis.__SHAPI_PREVIEW_LOCATION__.origin')
    expect(result).toContain('return window.location')
    expect(result).toContain('"window.location"')
    expect(rewritePreviewScript(source)).toBe(result)
})

it('preserves ES module imports and refuses invalid scripts instead of inventing code', () => {
    const result = rewritePreviewScript('import { fn } from "./dep.js";export const load=()=>import("./route.js");fn(window.location);')
    expect(result).toMatch(/from\s*"\.\/dep\.js"/)
    expect(result).toContain('import("./route.js")')
    expect(() => rewritePreviewScript('const = broken')).toThrow()
})

it('disables macro execution before module resolution and does not inline Hub environment', () => {
    for (const source of [
        'import { run } from "not-a-real-macro" with { type: "macro" };run();',
        'import { run } from "macro:not-a-real-macro";run();'
    ]) expect(() => rewritePreviewScript(source)).toThrow('Macros are disabled')
    expect(rewritePreviewScript('console.log(process.env.SHAPI_PREVIEW_TEST_SECRET)')).toContain('process.env.SHAPI_PREVIEW_TEST_SECRET')
    expect(rewritePreviewScript('console.log(process.env.NODE_ENV)')).toContain('process.env.NODE_ENV')
})
