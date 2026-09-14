import { useNavigate } from '@tanstack/react-router'
import { SettingsPageContent } from '@/routes/settings'

export default function VoicePluginPage() {
    const navigate = useNavigate()
    return <SettingsPageContent mode="voice" onBack={() => navigate({ to: '/plugins' })} />
}
