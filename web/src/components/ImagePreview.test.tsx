import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ImagePreview } from './ImagePreview'

const lightboxState = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null
}))

vi.mock('yet-another-react-lightbox', () => ({
    default: (props: Record<string, unknown>) => {
        lightboxState.props = props
        return props.open ? <div data-testid="image-lightbox" /> : null
    }
}))

vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => {} }))
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => {} }))
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => {} }))

describe('ImagePreview', () => {
    it('opens the clicked image inside its supplied gallery', () => {
        render(
            <I18nProvider>
                <ImagePreview
                    src="blob:second"
                    fileName="second.png"
                    label="Second image"
                    gallery={[
                        { src: 'blob:first', fileName: 'first.png', label: 'First image' },
                        { src: 'blob:second', fileName: 'second.png', label: 'Second image' }
                    ]}
                />
            </I18nProvider>
        )

        fireEvent.click(screen.getByTitle('Open image viewer'))

        expect(screen.getByTestId('image-lightbox')).toBeInTheDocument()
        expect(lightboxState.props).toMatchObject({
            open: true,
            index: 1,
            slides: [
                { src: 'blob:first', download: { filename: 'first.png' } },
                { src: 'blob:second', download: { filename: 'second.png' } }
            ]
        })
    })
})
