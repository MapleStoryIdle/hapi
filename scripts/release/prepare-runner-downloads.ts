import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

interface ArtifactDefinition {
    target: string
    fileName: string
    platform: 'darwin' | 'linux'
    arch: 'arm64' | 'x64'
}

const artifacts: ArtifactDefinition[] = [
    { target: 'bun-darwin-arm64', fileName: 'hapi-darwin-arm64.tar.gz', platform: 'darwin', arch: 'arm64' },
    { target: 'bun-darwin-x64', fileName: 'hapi-darwin-x64.tar.gz', platform: 'darwin', arch: 'x64' },
    { target: 'bun-linux-arm64', fileName: 'hapi-linux-arm64.tar.gz', platform: 'linux', arch: 'arm64' },
    { target: 'bun-linux-x64-baseline', fileName: 'hapi-linux-x64-baseline.tar.gz', platform: 'linux', arch: 'x64' },
]

function argument(name: string): string | undefined {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(path: string): string {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function main(): Promise<void> {
    const repoRoot = resolve(import.meta.dir, '../..')
    const runnerVersion = JSON.parse(readFileSync(join(repoRoot, 'cli/runner-version.json'), 'utf8')) as { version: string }
    const version = argument('--version') ?? runnerVersion.version
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error(`Invalid stable version: ${version}`)
    const downloadBaseUrl = argument('--download-base-url')
        ?? `https://github.com/MapleStoryIdle/hapi/releases/download/runner-v${version}`
    if (!/^https:\/\//.test(downloadBaseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(downloadBaseUrl)) {
        throw new Error(`Download base URL must use HTTPS (except loopback): ${downloadBaseUrl}`)
    }

    const binariesDir = resolve(argument('--binaries-dir') ?? join(repoRoot, 'cli/dist-exe'))
    const builtVersionPath = join(binariesDir, 'runner-version.txt')
    if (!existsSync(builtVersionPath) || readFileSync(builtVersionPath, 'utf8').trim() !== version) {
        throw new Error(`Runner binaries were not built for version ${version}`)
    }
    const outputDir = resolve(argument('--output-dir') ?? join(repoRoot, 'dist/runner-downloads'))
    const releaseDir = join(outputDir, 'runner', version)
    rmSync(outputDir, { recursive: true, force: true })
    mkdirSync(releaseDir, { recursive: true })

    const manifestArtifacts: Array<Record<string, string | number>> = []
    const checksumLines: string[] = []
    for (const artifact of artifacts) {
        const binary = join(binariesDir, artifact.target, 'hapi')
        if (!existsSync(binary)) throw new Error(`Missing runner binary: ${binary}`)
        const archive = join(releaseDir, artifact.fileName)
        const process = Bun.spawnSync({
            cmd: ['tar', '-czf', archive, '-C', join(binariesDir, artifact.target), 'hapi'],
            stdout: 'inherit',
            stderr: 'inherit',
        })
        if (process.exitCode !== 0) throw new Error(`Unable to package ${artifact.target}`)
        const digest = sha256(archive)
        checksumLines.push(`${digest}  ${artifact.fileName}`)
        manifestArtifacts.push({
            platform: artifact.platform,
            arch: artifact.arch,
            file: artifact.fileName,
            sha256: digest,
            size: statSync(archive).size,
        })
    }

    writeFileSync(join(releaseDir, 'checksums.txt'), `${checksumLines.join('\n')}\n`, 'utf8')
    writeFileSync(join(outputDir, 'runner', 'latest.json'), `${JSON.stringify({
        version,
        publishedAt: new Date().toISOString(),
        downloadBaseUrl: downloadBaseUrl.replace(/\/$/, ''),
        artifacts: manifestArtifacts,
    }, null, 2)}\n`, 'utf8')
    copyFileSync(join(repoRoot, 'scripts/install.sh'), join(outputDir, 'install.sh'))

    console.log(`Prepared Runner downloads: ${outputDir}`)
    for (const file of readdirSync(releaseDir)) console.log(`  ${version}/${basename(file)}`)
}

await main()
