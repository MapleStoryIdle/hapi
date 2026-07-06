import { useEffect, useState } from 'react'
import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { isPreviewableImageMimeType } from '@/lib/fileAttachments'
import { ImagePreview } from '@/components/ImagePreview'
import { useHappyChatContext } from '@/components/AssistantChat/context'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ImageAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    const ctx = useHappyChatContext()
    const [objectUrl, setObjectUrl] = useState<string | null>(null)

    useEffect(() => {
        let disposed = false
        let nextObjectUrl: string | null = null
        setObjectUrl(null)

        void ctx.api.getUploadedFileBlob(ctx.sessionId, attachment.path)
            .then((blob) => {
                if (disposed) return
                if (!isPreviewableImageMimeType(blob.type)) {
                    setObjectUrl(null)
                    return
                }
                nextObjectUrl = URL.createObjectURL(blob)
                setObjectUrl(nextObjectUrl)
            })
            .catch(() => {
                if (!disposed) setObjectUrl(null)
            })

        return () => {
            disposed = true
            if (nextObjectUrl) {
                URL.revokeObjectURL(nextObjectUrl)
            }
        }
    }, [attachment.path, ctx.api, ctx.sessionId])

    if (!objectUrl) {
        return <FileAttachment attachment={attachment} />
    }

    return (
        <ImagePreview
            src={objectUrl}
            fileName={attachment.filename}
            label={attachment.filename}
            buttonClassName="relative overflow-hidden rounded-lg text-left cursor-zoom-in"
            imageClassName="max-h-48 max-w-full object-contain"
            caption={(
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                    <span className="text-xs text-white/90 line-clamp-1">
                        {attachment.filename}
                    </span>
                </div>
            )}
        />
    )
}

function FileAttachment(props: { attachment: AttachmentMetadata }) {
    const { attachment } = props
    return (
        <div className="flex items-center gap-2 rounded-lg bg-[var(--app-bg)] px-3 py-2">
            <FileIcon fileName={attachment.filename} size={24} />
            <div className="min-w-0 flex-1">
                <div className="truncate text-base font-medium text-[var(--app-fg)]">
                    {attachment.filename}
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    {formatFileSize(attachment.size)}
                </div>
            </div>
        </div>
    )
}

export function MessageAttachments(props: { attachments: AttachmentMetadata[] }) {
    const { attachments } = props
    if (!attachments || attachments.length === 0) return null

    const images = attachments.filter(a => isPreviewableImageMimeType(a.mimeType))
    const files = attachments.filter(a => !isPreviewableImageMimeType(a.mimeType))

    return (
        <div className="mt-2 flex flex-col gap-2">
            {images.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {images.map(attachment => (
                        <ImageAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
            {files.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    {files.map(attachment => (
                        <FileAttachment key={attachment.id} attachment={attachment} />
                    ))}
                </div>
            )}
        </div>
    )
}
