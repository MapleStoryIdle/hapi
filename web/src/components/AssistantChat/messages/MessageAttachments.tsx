import { useEffect, useMemo, useState } from 'react'
import type { AttachmentMetadata } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { isPreviewableImageMimeType } from '@/lib/fileAttachments'
import { ImagePreview, type ImagePreviewGalleryItem } from '@/components/ImagePreview'
import { useHappyChatContext } from '@/components/AssistantChat/context'

function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type ImageAttachmentState = {
    status: 'loading' | 'ready' | 'error'
    src?: string
}

function ImageAttachmentGallery(props: { attachments: AttachmentMetadata[] }) {
    const { attachments } = props
    const ctx = useHappyChatContext()
    const [imageStates, setImageStates] = useState<Record<string, ImageAttachmentState>>({})
    const attachmentSignature = attachments.map((attachment) => [
        attachment.id,
        attachment.path,
        attachment.filename,
        attachment.mimeType
    ].join(':')).join('|')

    useEffect(() => {
        let disposed = false
        const objectUrls = new Set<string>()
        setImageStates(Object.fromEntries(attachments.map((attachment) => [
            attachment.id,
            { status: 'loading' }
        ])))

        for (const attachment of attachments) {
            void ctx.api.getUploadedFileBlob(ctx.sessionId, attachment.path)
                .then((blob) => {
                    if (!isPreviewableImageMimeType(blob.type)) {
                        throw new Error('Unsupported image type')
                    }
                    const src = URL.createObjectURL(blob)
                    objectUrls.add(src)
                    if (disposed) {
                        URL.revokeObjectURL(src)
                        return
                    }
                    setImageStates((current) => ({
                        ...current,
                        [attachment.id]: { status: 'ready', src }
                    }))
                })
                .catch(() => {
                    if (disposed) return
                    setImageStates((current) => ({
                        ...current,
                        [attachment.id]: { status: 'error' }
                    }))
                })
        }

        return () => {
            disposed = true
            for (const objectUrl of objectUrls) {
                URL.revokeObjectURL(objectUrl)
            }
        }
    }, [attachmentSignature, ctx.api, ctx.sessionId])

    const gallery = useMemo<ImagePreviewGalleryItem[]>(() => (
        attachments.flatMap((attachment) => {
            const image = imageStates[attachment.id]
            if (image?.status !== 'ready' || !image.src) return []
            return [{
                src: image.src,
                fileName: attachment.filename,
                label: attachment.filename
            }]
        })
    ), [attachments, imageStates])

    return (
        <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => {
                const image = imageStates[attachment.id]
                if (image?.status === 'ready' && image.src) {
                    return (
                        <ImagePreview
                            key={attachment.id}
                            src={image.src}
                            fileName={attachment.filename}
                            label={attachment.filename}
                            gallery={gallery}
                            buttonClassName="relative overflow-hidden rounded-lg text-left cursor-zoom-in"
                            imageClassName="max-h-48 max-w-full object-contain"
                            caption={(
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-2 py-1.5">
                                    <span className="text-xs text-white/90 line-clamp-1">
                                        {attachment.filename}
                                    </span>
                                </div>
                            )}
                        />
                    )
                }

                if (image?.status === 'error') {
                    return <FileAttachment key={attachment.id} attachment={attachment} />
                }

                return (
                    <div
                        key={attachment.id}
                        className="h-32 w-40 max-w-full animate-pulse rounded-lg bg-[var(--app-subtle-bg)]"
                        aria-label={attachment.filename}
                    />
                )
            })}
        </div>
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
                <ImageAttachmentGallery attachments={images} />
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
