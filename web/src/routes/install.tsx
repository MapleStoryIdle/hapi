export default function RunnerInstallPage() {
    const hubUrl = typeof window === 'undefined' ? '' : window.location.origin
    const hostname = typeof window === 'undefined' ? '' : window.location.hostname
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    const isDefaultHub = hubUrl === 'https://hapi.ye2moe.fun'
    const install = `curl -fsSL ${hubUrl}/install.sh | sh${isDefaultHub ? '' : ` -s -- --base-url ${hubUrl}`}`

    return (
        <main className="min-h-full bg-[var(--app-bg)] text-[var(--app-fg)] p-6">
            <div className="mx-auto max-w-2xl space-y-6">
                <header className="space-y-2">
                    <h1 className="text-2xl font-semibold">Install a SHAPI runner</h1>
                    <p className="text-sm text-[var(--app-hint)]">The installer creates or joins a workspace, pairs this computer, and starts the Runner.</p>
                </header>
                <section className="space-y-2">
                    <h2 className="font-medium">Install or update</h2>
                    <pre className="overflow-x-auto rounded-xl bg-black/80 p-4 text-sm text-white"><code>{install}</code></pre>
                    <p className="text-sm text-[var(--app-hint)]">On a fresh install, choose a new workspace or enter an existing spw credential. The installer pairs and starts the Runner automatically, then prints the Hub address and spw. Running the command again updates and restarts the Runner.</p>
                </section>
                <section className="space-y-2">
                    <h2 className="font-medium">Uninstall</h2>
                    <pre className="overflow-x-auto rounded-xl bg-black/80 p-4 text-sm text-white"><code>{`shapi uninstall\nshapi uninstall --purge`}</code></pre>
                    <p className="text-sm text-[var(--app-hint)]">The default keeps local credentials for reinstalling. Use --purge to remove all SHAPI settings and credentials.{isLoopback ? '' : ' Public Hubs must use HTTPS.'}</p>
                </section>
            </div>
        </main>
    )
}
