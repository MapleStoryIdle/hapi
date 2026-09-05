import { useCallback, useMemo, useState, type ReactNode, type SyntheticEvent } from 'react'
import Lightbox, { type Slide } from 'yet-another-react-lightbox'
import Captions from 'yet-another-react-lightbox/plugins/captions'
import Download from 'yet-another-react-lightbox/plugins/download'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/captions.css'
import { useReducedMotion } from 'motion/react'
import { useTranslation } from '@/lib/use-translation'

export type ImagePreviewGalleryItem = {
    src: string
    fileName: string
    label: string
    viewerTitle?: string
}

function toSlide(item: ImagePreviewGalleryItem): Slide {
    return {
        src: item.src,
        alt: item.label,
        title: item.viewerTitle ?? item.fileName,
        download: {
            url: item.src,
            filename: item.fileName
        }
    }
}

export function ImagePreview(props: {
    src: string
    fileName: string
    label: string
    viewerTitle?: string
    buttonClassName?: string
    imageClassName?: string
    caption?: ReactNode
    gallery?: readonly ImagePreviewGalleryItem[]
}) {
    const { t } = useTranslation()
    const reducedMotion = useReducedMotion()
    const [viewerOpen, setViewerOpen] = useState(false)
    const items = useMemo<ImagePreviewGalleryItem[]>(() => {
        if (props.gallery && props.gallery.length > 0) {
            return [...props.gallery]
        }
        return [{
            src: props.src,
            fileName: props.fileName,
            label: props.label,
            viewerTitle: props.viewerTitle
        }]
    }, [props.fileName, props.gallery, props.label, props.src, props.viewerTitle])
    const currentIndex = useMemo(() => {
        const index = items.findIndex((item) => item.src === props.src)
        return index >= 0 ? index : 0
    }, [items, props.src])
    const [activeSource, setActiveSource] = useState(props.src)
    const viewerIndex = useMemo(() => {
        const index = items.findIndex((item) => item.src === activeSource)
        return index >= 0 ? index : currentIndex
    }, [activeSource, currentIndex, items])
    const slides = useMemo(() => items.map(toSlide), [items])

    const stopEvent = useCallback((event: SyntheticEvent) => {
        event.stopPropagation()
    }, [])

    const openViewer = useCallback((event: SyntheticEvent) => {
        event.preventDefault()
        event.stopPropagation()
        setActiveSource(props.src)
        setViewerOpen(true)
    }, [props.src])

    const closeViewer = useCallback(() => {
        setViewerOpen(false)
    }, [])

    return (
        <>
            <button
                type="button"
                onPointerDown={stopEvent}
                onMouseDown={stopEvent}
                onTouchStart={stopEvent}
                onClick={openViewer}
                className={props.buttonClassName ?? 'group flex min-h-[18rem] w-full items-center justify-center overflow-auto rounded-md border border-[var(--app-border)] bg-[var(--app-code-bg)] p-3 text-left'}
                title={t('imagePreview.open')}
            >
                <img
                    src={props.src}
                    alt={props.label}
                    className={props.imageClassName ?? 'max-h-[calc(100vh-14rem)] max-w-full object-contain transition-transform group-hover:scale-[1.01]'}
                    draggable={false}
                />
                {props.caption}
                <span className="sr-only">{props.fileName}</span>
            </button>

            <Lightbox
                className="chat-media-viewer"
                open={viewerOpen}
                close={closeViewer}
                index={viewerIndex}
                slides={slides}
                plugins={[Captions, Download, Zoom]}
                animation={{ fade: reducedMotion ? 0 : 160, swipe: reducedMotion ? 0 : 220 }}
                carousel={{
                    finite: items.length <= 1,
                    preload: Math.min(2, Math.max(0, items.length - 1)),
                    padding: '5%'
                }}
                controller={{
                    closeOnBackdropClick: true,
                    closeOnPullDown: true,
                    closeOnPullUp: false
                }}
                zoom={{
                    maxZoomPixelRatio: 4,
                    scrollToZoom: true
                }}
                captions={{
                    showToggle: false,
                    descriptionMaxLines: 1
                }}
                labels={{
                    Close: t('imagePreview.close'),
                    Previous: t('imagePreview.previous'),
                    Next: t('imagePreview.next'),
                    Download: t('imagePreview.download'),
                    'Zoom in': t('imagePreview.zoomIn'),
                    'Zoom out': t('imagePreview.zoomOut'),
                    'Photo gallery': t('imagePreview.gallery'),
                    '{index} of {total}': t('imagePreview.counter')
                }}
                on={{
                    view: ({ index }) => setActiveSource(items[index]?.src ?? props.src)
                }}
                styles={{
                    container: {
                        backgroundColor: 'var(--chat-media-bg)'
                    },
                    button: {
                        filter: 'none'
                    },
                    toolbar: {
                        paddingTop: 'calc(var(--app-safe-area-top) + 8px)',
                        paddingRight: 'calc(var(--app-safe-area-right) + 8px)'
                    }
                }}
            />
        </>
    )
}
