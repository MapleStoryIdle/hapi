import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            fontFamily: {
                sans: [
                    '"Test Tiempos Text"',
                    '"Tiempos Text"',
                    '"Tiempos"',
                    'ui-serif',
                    'Georgia',
                    'Cambria',
                    '"Times New Roman"',
                    'Times',
                    'serif'
                ]
            },
            maxWidth: {
                content: 'var(--content-max-w, 960px)'
            }
        }
    },
    plugins: []
} satisfies Config
