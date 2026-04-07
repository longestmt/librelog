import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
    base: '/',
    root: '.',
    publicDir: 'public',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.svg'],
            manifest: {
                name: 'LibreLog',
                short_name: 'LibreLog',
                description: 'A libre, FLOSS meal tracking app',
                theme_color: '#1a1d21',
                background_color: '#1a1d21',
                display: 'standalone',
                start_url: '/',
                icons: [
                    {
                        src: 'favicon.svg',
                        sizes: 'any',
                        type: 'image/svg+xml',
                        purpose: 'any maskable',
                    },
                ],
            },
            workbox: {
                globPatterns: ['**/*.{js,css,html,svg,woff2}'],
                runtimeCaching: [
                    {
                        urlPattern: /^https:\/\/world\.openfoodfacts\.org\/api\//,
                        handler: 'StaleWhileRevalidate',
                        options: {
                            cacheName: 'off-api-cache',
                            expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 60 * 60 },
                        },
                    },
                ],
            },
        }),
    ],
});
