import { useState } from 'react'

type Pairing = {
    userCode: string
    displayName: string
    machineId: string
    publicKeyThumbprint: string
    state: string
    expiresAt: number
}

function csrfToken(): string | null {
    const value = document.cookie.split('; ').find((part) => part.startsWith('shapi_csrf='))?.slice('shapi_csrf='.length)
    return value ? decodeURIComponent(value) : null
}

export default function PairRunnerPage() {
    const initialCode = new URLSearchParams(window.location.search).get('code')?.toUpperCase() ?? ''
    const [code, setCode] = useState(initialCode)
    const [pairing, setPairing] = useState<Pairing | null>(null)
    const [message, setMessage] = useState<string | null>(null)

    const request = async (path: string, method = 'GET') => {
        const headers: Record<string, string> = { accept: 'application/json' }
        const csrf = csrfToken()
        if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf
        const response = await fetch(new URL(path, window.location.origin), { method, credentials: 'include', headers })
        if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? 'Request failed')
        return response
    }

    const lookup = async () => {
        setMessage(null)
        try {
            const response = await request(`/api/v2/runner/device-authorizations/${encodeURIComponent(code.trim().toUpperCase())}`)
            setPairing(await response.json() as Pairing)
        } catch (error) {
            setPairing(null)
            setMessage(error instanceof Error ? error.message : 'Pairing not found')
        }
    }

    const decide = async (decision: 'approve' | 'deny') => {
        if (!pairing) return
        try {
            await request(`/api/v2/runner/device-authorizations/${pairing.userCode}/${decision}`, 'POST')
            setMessage(decision === 'approve' ? 'Runner approved. You can return to the computer.' : 'Pairing denied.')
            setPairing({ ...pairing, state: decision === 'approve' ? 'approved' : 'denied' })
        } catch (error) {
            setMessage(error instanceof Error ? error.message : 'Request failed')
        }
    }

    return (
        <main className="min-h-full p-6">
            <div className="mx-auto max-w-lg space-y-5">
                <h1 className="text-2xl font-semibold">Pair a runner</h1>
                <div className="flex gap-2">
                    <input className="ios-form-control min-w-0 flex-1 px-3 py-2 uppercase" value={code} maxLength={8} onChange={(event) => setCode(event.target.value)} placeholder="8-character code" />
                    <button className="rounded-lg bg-[var(--app-button)] px-4 text-[var(--app-button-text)]" onClick={() => void lookup()}>Check</button>
                </div>
                {pairing ? (
                    <section className="space-y-3 rounded-xl border border-[var(--app-border)] p-4">
                        <div><span className="text-[var(--app-hint)]">Computer:</span> {pairing.displayName}</div>
                        <div className="break-all text-sm"><span className="text-[var(--app-hint)]">Machine:</span> {pairing.machineId}</div>
                        <div className="break-all text-sm"><span className="text-[var(--app-hint)]">Key fingerprint:</span> {pairing.publicKeyThumbprint}</div>
                        <div className="flex gap-2">
                            <button disabled={pairing.state !== 'pending'} className="rounded-lg bg-[var(--app-button)] px-4 py-2 text-[var(--app-button-text)] disabled:opacity-50" onClick={() => void decide('approve')}>Approve</button>
                            <button disabled={pairing.state !== 'pending'} className="rounded-lg border px-4 py-2 disabled:opacity-50" onClick={() => void decide('deny')}>Deny</button>
                        </div>
                    </section>
                ) : null}
                {message ? <p className="text-sm">{message}</p> : null}
            </div>
        </main>
    )
}
