import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import {
    PlanStatusSummary,
    extractLatestPlanStatus,
    getRunScopedPlanStatus,
    hasActiveToolBlock,
    removeChatBlockById
} from '@/components/AssistantChat/PlanStatusSummary'

function makeToolBlock(
    id: string,
    name: string,
    input: unknown,
    overrides: Partial<ToolCallBlock> = {}
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 0,
        tool: {
            id,
            name,
            state: 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            result: undefined
        },
        children: [],
        ...overrides
    }
}

function renderSummary(plan = extractLatestPlanStatus([
    makeToolBlock('plan-1', 'update_plan', {
        plan: [
            { step: '确认 router/realtime 依赖边界', status: 'completed' },
            { step: '实现路由懒加载', status: 'in_progress' },
            { step: '实现语音懒加载', status: 'pending' }
        ]
    })
])) {
    return render(
        <I18nProvider>
            <PlanStatusSummary plan={plan} />
        </I18nProvider>
    )
}

afterEach(() => {
    cleanup()
})

beforeEach(() => {
    localStorage.setItem('hapi-lang', 'zh-CN')
})

describe('PlanStatusSummary helpers', () => {
    // 验证提取最新有效 update_plan，并计算底部胶囊需要的当前步骤和进度。
    it('extracts the latest valid plan status summary', () => {
        const summary = extractLatestPlanStatus([
            makeToolBlock('plan-old', 'update_plan', {
                plan: [
                    { step: '旧计划', status: 'in_progress' }
                ]
            }),
            makeToolBlock('read-1', 'Read', { file_path: 'README.md' }),
            makeToolBlock('plan-new', 'update_plan', {
                plan: [
                    { step: '确认边界', status: 'completed' },
                    { step: '实现胶囊', status: 'in_progress' },
                    { step: '补测试', status: 'pending' }
                ]
            })
        ])

        expect(summary).toMatchObject({
            sourceBlockId: 'plan-new',
            total: 3,
            completed: 1,
            currentIndex: 1,
            currentStep: { text: '实现胶囊', status: 'in_progress' }
        })
    })

    // 验证运行态判断会递归检查子工具，避免 Agent/Task 包裹后漏掉运行中的工具。
    it('detects active nested tool blocks', () => {
        const child = makeToolBlock('child-1', 'Bash', { command: 'bun typecheck' }, {
            tool: {
                id: 'child-1',
                name: 'Bash',
                state: 'running',
                input: { command: 'bun typecheck' },
                createdAt: 0,
                startedAt: 0,
                completedAt: null,
                description: null
            }
        })
        const parent = makeToolBlock('agent-1', 'Agent', {}, {
            children: [child]
        })

        expect(hasActiveToolBlock([parent])).toBe(true)
    })

    // 验证新一轮用户消息开始后，旧 run 遗留的 running/pending tool 不会继续把底部 plan 胶囊卡住。
    it('ignores active tool blocks before the current turn scope', () => {
        const stale = makeToolBlock('stale-1', 'Bash', { command: 'sleep 1' }, {
            createdAt: 10,
            tool: {
                id: 'stale-1',
                name: 'Bash',
                state: 'running',
                input: { command: 'sleep 1' },
                createdAt: 10,
                startedAt: 10,
                completedAt: null,
                description: null
            }
        })
        const current = makeToolBlock('current-1', 'Read', { file_path: 'README.md' }, {
            createdAt: 30,
            tool: {
                id: 'current-1',
                name: 'Read',
                state: 'pending',
                input: { file_path: 'README.md' },
                createdAt: 30,
                startedAt: null,
                completedAt: null,
                description: null
            }
        })

        expect(hasActiveToolBlock([stale], { minCreatedAt: 20 })).toBe(false)
        expect(hasActiveToolBlock([stale, current], { minCreatedAt: 20 })).toBe(true)
    })

    // 验证新一轮用户消息开始后，旧 plan 不会作为当前 run 的底部进度继续展示。
    it('extracts only plan updates inside the current turn scope', () => {
        const summary = extractLatestPlanStatus([
            makeToolBlock('plan-old', 'update_plan', {
                plan: [{ step: '旧计划', status: 'in_progress' }]
            }, { createdAt: 10 }),
            makeToolBlock('read-1', 'Read', { file_path: 'README.md' }, { createdAt: 30 })
        ], { minCreatedAt: 20 })

        expect(summary).toBeNull()
    })

    // 验证运行结束后被清理过的 plan 不会在下一轮运行开始时重新冒出来。
    it('hides a cleared plan until a new update_plan block appears', () => {
        const oldPlan = extractLatestPlanStatus([
            makeToolBlock('plan-old', 'update_plan', {
                plan: [
                    { step: '旧计划', status: 'completed' }
                ]
            })
        ])
        const newPlan = extractLatestPlanStatus([
            makeToolBlock('plan-new', 'update_plan', {
                plan: [
                    { step: '新计划', status: 'in_progress' }
                ]
            })
        ])

        expect(getRunScopedPlanStatus(oldPlan, {
            runActive: true,
            clearedSourceBlockId: 'plan-old'
        })).toBeNull()
        expect(getRunScopedPlanStatus(newPlan, {
            runActive: true,
            clearedSourceBlockId: 'plan-old'
        })?.sourceBlockId).toBe('plan-new')
        expect(getRunScopedPlanStatus(newPlan, {
            runActive: false,
            clearedSourceBlockId: null
        })).toBeNull()
    })

    // 验证底部 plan 胶囊展示时，当前 plan block 可以从消息流中临时移除，避免重复展示。
    it('removes a matching chat block without mutating unrelated blocks', () => {
        const blocks: ChatBlock[] = [
            makeToolBlock('plan-1', 'update_plan', { plan: [{ step: 'A', status: 'pending' }] }),
            makeToolBlock('read-1', 'Read', { file_path: 'README.md' })
        ]

        const next = removeChatBlockById(blocks, 'plan-1')

        expect(next.map((block) => block.id)).toEqual(['read-1'])
        expect(blocks.map((block) => block.id)).toEqual(['plan-1', 'read-1'])
    })
})

describe('PlanStatusSummary', () => {
    // 验证折叠态保留整体完成进度，展开后在输入框上方展示完整计划。
    it('renders total progress while collapsed and expands an in-flow plan list', () => {
        renderSummary()

        const trigger = screen.getByRole('button', { name: /计划.*已完成 1\/3/ })
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByRole('progressbar', { name: '已完成 1/3' })).toHaveAttribute('aria-valuenow', '1')

        fireEvent.click(trigger)

        const list = screen.getByRole('region', { name: '当前计划' })
        expect(list).toBeInTheDocument()
        expect(list.querySelector('.overflow-y-auto')).toBeTruthy()
        expect(screen.getByText('确认 router/realtime 依赖边界')).toBeInTheDocument()
        expect(screen.getByText('实现语音懒加载')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).toBeNull()

        fireEvent.click(trigger)
        expect(trigger).toHaveAttribute('aria-expanded', 'false')
        expect(screen.queryByRole('region', { name: '当前计划' })).toBeNull()
    })

    // 验证弹窗展开状态会上报给父层，用于隐藏回到底部按钮。
    it('reports expanded state changes to the parent', () => {
        const onExpandedChange = vi.fn()
        const plan = extractLatestPlanStatus([
            makeToolBlock('plan-1', 'update_plan', {
                plan: [
                    { step: '实现计划胶囊', status: 'in_progress' }
                ]
            })
        ])
        render(
            <I18nProvider>
                <PlanStatusSummary plan={plan} onExpandedChange={onExpandedChange} />
            </I18nProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /计划.*已完成 0\/1/ }))

        expect(onExpandedChange).toHaveBeenCalledWith(true)
    })

    // 验证空 plan 不渲染任何底部状态，避免出现无意义胶囊。
    it('renders nothing without a valid plan', () => {
        const { container } = renderSummary(null)

        expect(container.textContent).toBe('')
    })
})
