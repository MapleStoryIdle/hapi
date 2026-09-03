import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoredArtifact, Store } from '../store'
import type { ShareSource, ShareSourceContext } from '@hapi/protocol/apiTypes'
import { feedbackBlobPath } from '../kanban/feedback'

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'csv', 'yaml', 'yml'])
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

export type RevokeShareResult =
    | { type: 'not-found' }
    | { type: 'deleted' }
    | { type: 'delete-failed' }

export function sha256(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex') }

export function isMarkdownShare(filename: string): boolean {
    return MARKDOWN_EXTENSIONS.has(filename.split('.').pop()?.toLowerCase() ?? '')
}

function feedbackContract(input: {
    endpoint: string
    token: string
    request: string | null
}): string {
    const request = input.request?.trim()
    const requestedWork = request
        ? `\n任务反馈重点：${request}\n`
        : '\n请总结结论、风险和建议下一步。\n'
    return `\n\n---\n\n## SHAPI 看板反馈\n\n此文件是一个可反馈的看板任务。读完后，如需把反馈交回 SHAPI，请提交一份 **不超过 10 MiB 的 UTF-8 Markdown** 到下方接口。\n${requestedWork}\n反馈文件必须以以下 front matter 开头（模型与环境信息为反馈 Agent 自报）：\n\n\`\`\`yaml\n---\nhapi_feedback: 1\nagent:\n  name: <agent name>\n  version: <agent version>\nmodel:\n  provider: <provider>\n  id: <model id>\n  reasoning_effort: <optional>\nenvironment:\n  os: <os>\n  arch: <arch>\n  runtime: <runtime>\n---\n\`\`\`\n\n发送时使用文件名的 Base64URL 作为 \`X-Hapi-Feedback-Filename\`（例如 \`review.md\` 为 \`cmV2aWV3Lm1k\`）：\n\n\`\`\`text\nPOST ${input.endpoint}\nAuthorization: Bearer ${input.token}\nContent-Type: text/markdown; charset=utf-8\nX-Hapi-Feedback-Filename: cmV2aWV3Lm1k\n\`\`\`\n\n成功会返回 \`201 {"ok":true}\`。若返回 \`400 Feedback format rejected\`，说明文件、front matter 或请求头格式不对；令牌尚未消耗，可修正后用**同一枚**令牌重试。若返回 \`404 Not found\`，请勿改用其他令牌重试。\n\n令牌仅可成功提交一次；请勿将它用于其他文件。\n`
}

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
    constructor(private readonly store: Store, private readonly dataDir: string) { this.dir = join(dataDir, 'artifacts'); mkdirSync(this.dir, { recursive: true, mode: 0o700 }); try { chmodSync(this.dir, 0o700) } catch {} }
    private path(id: string): string { return join(this.dir, `${id}.blob`) }
    publish(input: {
        namespace: string
        filename: string
        expiresSeconds: number
        bytes: Uint8Array
        makePublicUrl?: (token: string) => string
        source?: ShareSource | null
        sourceContext?: ShareSourceContext | null
        feedback?: {
            request?: string | null
            makeFeedbackUrl: (artifactId: string) => string
        }
    }): { artifact: StoredArtifact; token: string } {
        if (input.feedback && !isMarkdownShare(input.filename)) throw new Error('Feedback is only available for Markdown shares')
        if (input.feedback && !input.source) throw new Error('Feedback requires a source session')
        if (input.source?.type === 'hapi' && (input.source.sessionId.length > 255 || /[\u0000-\u001f\u007f]/.test(input.source.sessionId))) {
            throw new Error('Invalid source session')
        }
        if (input.source?.type === 'native-codex' && (
            input.source.machineId.length > 200 || input.source.codexSessionId.length > 200
            || /[\u0000-\u001f\u007f]/.test(input.source.machineId)
            || /[\u0000-\u001f\u007f]/.test(input.source.codexSessionId)
        )) throw new Error('Invalid native Codex source')
        if (input.feedback?.request && (input.feedback.request.length > 2000 || /[\u0000-\u001f\u007f]/.test(input.feedback.request))) {
            throw new Error('Invalid feedback request')
        }
        const id = randomBytes(16).toString('hex')
        const token = randomBytes(32).toString('base64url'); const tokenHash = sha256(token)
        const feedbackToken = input.feedback ? randomBytes(32).toString('base64url') : null
        const bytes = input.feedback
            ? new TextEncoder().encode(
                `${new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)}${feedbackContract({
                    endpoint: input.feedback.makeFeedbackUrl(id),
                    token: feedbackToken!,
                    request: input.feedback.request ?? null
                })}`
            )
            : input.bytes
        if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error('Share exceeds 10 MiB')
        const artifact = {
            namespace: input.namespace,
            tokenHash,
            publicUrl: input.makePublicUrl?.(token) ?? null,
            filename: input.filename,
            size: bytes.length,
            sha256: sha256(bytes),
            expiresAt: Date.now() + input.expiresSeconds * 1000
        }
        const temp = join(this.dir, `.${id}.${randomBytes(8).toString('hex')}.tmp`); const target = this.path(id)
        writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' }); try { chmodSync(temp, 0o600) } catch {}; renameSync(temp, target)
        try {
            const stored = this.store.artifacts.create({ ...artifact, id })
            try {
                this.store.kanbanTasks.create({
                    artifactId: id,
                    namespace: input.namespace,
                    source: input.source ?? null,
                    sourceContext: input.sourceContext ?? null,
                    feedbackRequest: input.feedback?.request ?? null,
                    feedbackTokenHash: feedbackToken ? sha256(feedbackToken) : null,
                    createdAt: stored.createdAt
                })
            } catch (error) {
                this.store.artifacts.deleteById(id)
                throw error
            }
            return { artifact: stored, token }
        } catch (error) { try { rmSync(target, { force: true }) } catch {}; throw error }
    }
    revoke(id: string, namespace: string, now = Date.now()): RevokeShareResult {
        const artifact = this.store.artifacts.markForDeletion(id, namespace, now)
        if (!artifact) return { type: 'not-found' }

        try {
            rmSync(this.path(artifact.id), { force: true })
            rmSync(feedbackBlobPath(this.dataDir, artifact.id), { force: true })
        } catch {
            // The database revocation already blocks public reads and feedback
            // uploads. Keep the row for an explicit owner retry; SHAPI never
            // deletes it in the background.
            console.warn('[Artifacts] Failed to delete share data')
            return { type: 'delete-failed' }
        }

        this.store.artifacts.deleteById(artifact.id)
        return { type: 'deleted' }
    }
    readPublic(token: string): { artifact: StoredArtifact; bytes: Uint8Array } | null {
        if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) return null
        const artifact = this.store.artifacts.findPublic(sha256(token)); if (!artifact) return null
        const path = this.path(artifact.id); if (!existsSync(path)) return null
        try { const bytes = readFileSync(path); return sha256(bytes) === artifact.sha256 ? { artifact, bytes } : null } catch { return null }
    }
    /** Owner-only callers can inspect an active shared file without its bearer URL. */
    readOwned(id: string, namespace: string): { artifact: StoredArtifact; bytes: Uint8Array } | null {
        const artifact = this.store.artifacts.findActive(id, namespace)
        if (!artifact) return null
        const path = this.path(artifact.id)
        if (!existsSync(path)) return null
        try {
            const bytes = readFileSync(path)
            return sha256(bytes) === artifact.sha256 ? { artifact, bytes } : null
        } catch {
            return null
        }
    }
}
