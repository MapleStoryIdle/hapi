import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'SHAPI',
  description: 'Control your AI agents from anywhere',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Quick Start', link: '/guide/quick-start' },
      { text: 'GitHub', link: 'https://github.com/MapleStoryIdle/shapi', target: '_blank' }
    ],

    sidebar: [
      { text: 'Quick Start', link: '/guide/quick-start' },
      { text: 'Installation', link: '/guide/installation' },
      { text: 'PWA', link: '/guide/pwa' },
      { text: 'How it Works', link: '/guide/how-it-works' },
      { text: 'Cursor Agent', link: '/guide/cursor' },
      { text: 'Voice Assistant', link: '/guide/voice-assistant' },
      { text: 'Why SHAPI', link: '/guide/why-hapi' },
      { text: 'FAQ', link: '/guide/faq' }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/MapleStoryIdle/shapi' }
    ],

    footer: {
      message: 'Released under the AGPL-3.0-only License.',
      copyright: 'Copyright © 2024-present'
    },

    search: {
      provider: 'local'
    }
  }
})
