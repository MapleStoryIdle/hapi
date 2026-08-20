import { describe, expect, it } from 'vitest'
import { buildOpenVikingStudioSrc } from './memory'

describe('buildOpenVikingStudioSrc', () => {
    it('keeps the selected runner and authentication token in the embedded Studio URL', () => {
        const url = buildOpenVikingStudioSrc({
            baseUrl: 'https://hapi.example',
            machineId: 'machine / 1',
            token: 'signed-token'
        })

        expect(url).toBe(
            'https://hapi.example/api/openviking/machines/machine%20%2F%201/studio/?hapiOpenVikingToken=signed-token'
        )
    })
})
