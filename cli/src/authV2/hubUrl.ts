import { configuration } from '@/configuration'
import { updateSettings } from '@/persistence'
import { initializeApiUrl } from '@/ui/apiUrlInit'
import { normalizeHubUrl } from './credentials'

export async function resolveAuthV2HubUrl(explicitHubUrl?: string): Promise<string> {
    if (!explicitHubUrl) {
        const source = await initializeApiUrl()
        const previous = configuration.apiUrl
        const hubUrl = normalizeHubUrl(previous)
        configuration._setApiUrl(hubUrl)
        if (source === 'settings' && previous !== hubUrl) {
            await updateSettings(current => ({ ...current, apiUrl: hubUrl }))
        }
        return hubUrl
    }

    const hubUrl = normalizeHubUrl(explicitHubUrl)
    configuration._setApiUrl(hubUrl)
    await updateSettings(current => ({ ...current, apiUrl: hubUrl }))
    return hubUrl
}
