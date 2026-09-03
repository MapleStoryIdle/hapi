import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            fontFamily: {
                sans: [
                    'ui-sans-serif',
                    'system-ui',
                    '-apple-system',
                    'BlinkMacSystemFont',
                    '"SF Pro Text"',
                    '"Segoe UI"',
                    'sans-serif'
                ]
            },
            maxWidth: {
                content: 'var(--content-max-w, 960px)'
            }
        }
    },
    plugins: []
} satisfies Config
