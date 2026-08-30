import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoredArtifact, Store } from '../store'

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'yaml', 'yml'])

export type RevokeShareResult =
    | { type: 'not-found' }
    | { type: 'revoked'; cleanupPending: boolean }

export function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }
export function artifactContentType(filename: string, bytes: Uint8Array): { type: string; inline: boolean } {
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    const png = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    const gif = bytes.length >= 6 && (Buffer.from(bytes.subarray(0, 6)).toString() === 'GIF87a' || Buffer.from(bytes.subarray(0, 6)).toString() === 'GIF89a')
    const webp = bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString() === 'WEBP'
    const avif = bytes.length >= 16 && Buffer.from(bytes.subarray(4, 8)).toString() === 'ftyp' && Buffer.from(bytes.subarray(8, 16)).toString().includes('avif')
    if (png) return { type: 'image/png', inline: true }; if (jpeg) return { type: 'image/jpeg', inline: true }; if (gif) return { type: 'image/gif', inline: true }; if (webp) return { type: 'image/webp', inline: true }; if (avif) return { type: 'image/avif', inline: true }
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    return TEXT_EXTENSIONS.has(ext) ? { type: 'text/plain; charset=utf-8', inline: true } : { type: 'application/octet-stream', inline: false }
}
export class ArtifactService {
    private readonly dir: string
    constructor(private readonly store: Store, dataDir: string) { this.dir = join(dataDir, 'artifacts'); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); try { chmodSync(this.dir, 0o700) } catch {} }
    private path(id: string): string { return join(this.dir, `${id}.blob`) }
    publish(input: {
        namespace: string
        filename: string
        expiresSeconds: number
        bytes: Uint8Array
        makePublicUrl?: (token: string) => string
    }): { artifact: StoredArtifact; token: string } {
        if (input.bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Share exceeds 10 MiB')
        const token = randomBytes(32).toString('base64url'); const tokenHash = sha256(token)
        const artifact = {
            namespace: input.namespace,
            tokenHash,
            publicUrl: input.makePublicUrl?.(token) ?? null,
            filename: input.filename,
            size: input.bytes.length,
            sha256: sha256(input.bytes),
            expiresAt: Date.now() + input.expiresSeconds * 1000
        }
        const id = randomBytes(16).toString('hex'); const temp = join(this.dir, `.${id}.${randomBytes(8).toString('hex')}.tmp`); const target = this.path(id)
        writeFileSync(temp, input.bytes, { mode: 0o600, flag: 'wx' }); try { chmodSync(temp, 0o600) } catch {}; renameSync(temp, target)
        try { return { artifact: this.store.artifacts.create({ ...artifact, id }), token } } catch (error) { try { rmSync(target, { force: true }) } catch {}; throw error }
    }
    revoke(id: string, namespace: string, now = Date.now()): RevokeShareResult {
        const artifact = this.store.artifacts.revokeActive(id, namespace, now)
        if (!artifact) return { type: 'not-found' }

        try {
            rmSync(this.path(artifact.id), { force: true })
            return { type: 'revoked', cleanupPending: false }
        } catch {
            // The database revocation has already blocked the public bearer URL.
            // Keep its tombstone so the periodic cleanup can retry the blob removal.
            console.warn('[Artifacts] Failed to clean revoked share blob')
            return { type: 'revoked', cleanupPending: true }
        }
    }

    cleanupExpired(now = Date.now()): number {
        let cleaned = 0
        for (const artifact of this.store.artifacts.listCleanupCandidates(now)) {
            try {
                rmSync(this.path(artifact.id), { force: true })
            } catch {
                console.warn('[Artifacts] Failed to clean share blob')
                continue
            }
            if (this.store.artifacts.deleteCleanupCandidate(artifact.id, now)) cleaned++
        }
        return cleaned
    }
    readPublic(token: string): { artifact: StoredArtifact; bytes: Uint8Array } | null {
        if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) return null
        const artifact = this.store.artifacts.findPublic(sha256(token)); if (!artifact) return null
        const path = this.path(artifact.id); if (!existsSync(path)) return null
        try { const bytes = readFileSync(path); return sha256(bytes) === artifact.sha256 ? { artifact, bytes } : null } catch { return null }
    }
}
