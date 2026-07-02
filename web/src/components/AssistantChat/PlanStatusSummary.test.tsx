import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatBlock, ToolCallBlock } from '@/chat/types'
import { I18nProvider } from '@/lib/i18n-context'
import {
    PlanStatusSummary,
    extractLatestPlanStatus,
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
    // 验证折叠态展示计划进度和当前步骤，点击后展开详细计划弹窗。
    it('renders the plan pill and expands a scrollable dialog', () => {
        renderSummary()

        expect(screen.getByRole('button', { name: /计划 2\/3 实现路由懒加载/ })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /计划 2\/3 实现路由懒加载/ }))

        const dialog = screen.getByRole('dialog', { name: '当前计划' })
        expect(dialog).toBeInTheDocument()
        expect(dialog).toHaveStyle({
            width: 'max-content',
            minWidth: '14rem',
            maxWidth: 'min(50vw, 28rem)',
            maxHeight: 'min(50vh, 22rem)'
        })
        expect(dialog.querySelector('.overflow-y-auto')).toBeTruthy()
        expect(screen.getByText('确认 router/realtime 依赖边界')).toBeInTheDocument()
        expect(screen.getByText('实现语音懒加载')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
        expect(screen.queryByText('已完成')).toBeNull()
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

        fireEvent.click(screen.getByRole('button', { name: /计划 1\/1 实现计划胶囊/ }))

        expect(onExpandedChange).toHaveBeenCalledWith(true)
    })

    // 验证空 plan 不渲染任何底部状态，避免出现无意义胶囊。
    it('renders nothing without a valid plan', () => {
        const { container } = renderSummary(null)

        expect(container.textContent).toBe('')
    })
})
