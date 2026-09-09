import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeQuestionSummary } from './NativeQuestionCards'

afterEach(cleanup)

describe('NativeQuestionSummary compact preview', () => {
    const questions = [{ id: 'q', question: 'A long question', options: [{ label: 'Keep (Recommended)' }, { label: 'Change' }] }]

    it('limits the question to two lines and shows only recommended options', () => {
        render(<NativeQuestionSummary questions={questions} status="Question" pending />)
        expect(screen.getByText('A long question').className).toContain('line-clamp-2')
        expect(screen.getByText('A long question').className).toContain('text-sm')
        expect(screen.getByText('Keep (Recommended)')).toBeTruthy()
        expect(screen.queryByText('Change')).toBeNull()
    })

    it('recognizes Chinese recommendations and does not invent one', () => {
        render(<NativeQuestionSummary questions={[{ id: 'q', question: '选择', options: ['保留（推荐）', '其他'] }, { id: 'q2', question: '继续吗', options: ['Yes'] }]} status="Question" pending />)
        expect(screen.getByText('保留（推荐）')).toBeTruthy()
        expect(screen.queryByText('Yes')).toBeNull()
    })

    it('shows the actual answer instead of the recommendation once answered', () => {
        render(<NativeQuestionSummary questions={questions} status="Answered" answers={{ q: ['Change'] }} />)
        expect(screen.getByText('Change')).toBeTruthy()
        expect(screen.queryByText('Keep (Recommended)')).toBeNull()
    })
})
