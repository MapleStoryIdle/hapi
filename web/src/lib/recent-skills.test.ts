import { afterEach, describe, expect, it } from 'vitest'
import {
    getProjectRecentSkills,
    markProjectSkillUsed,
    MAX_PROJECT_RECENT_SKILLS
} from './recent-skills'

describe('project recent skills', () => {
    afterEach(() => {
        localStorage.clear()
    })

    it('keeps an isolated three-item MRU list for each project path', () => {
        markProjectSkillUsed('/work/alpha', 'one')
        markProjectSkillUsed('/work/alpha', 'two')
        markProjectSkillUsed('/work/alpha', 'three')
        markProjectSkillUsed('/work/alpha', 'four')
        markProjectSkillUsed('/work/beta', 'other')

        expect(MAX_PROJECT_RECENT_SKILLS).toBe(3)
        expect(getProjectRecentSkills('/work/alpha')).toEqual(['four', 'three', 'two'])
        expect(getProjectRecentSkills('/work/beta')).toEqual(['other'])
    })

    it('moves an existing skill to the front and normalizes trailing slashes', () => {
        markProjectSkillUsed('/work/alpha/', 'one')
        markProjectSkillUsed('/work/alpha', 'two')
        markProjectSkillUsed('/work/alpha', 'one')

        expect(getProjectRecentSkills('/work/alpha/')).toEqual(['one', 'two'])
    })
})
