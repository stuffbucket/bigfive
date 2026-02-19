import { defineConfig } from 'vite';
import { readFileSync } from 'fs';

// Support both root deployment (custom domain) and sub-path (/repo-name/).
// Set VITE_BASE_PATH env var for sub-path, e.g. VITE_BASE_PATH=/bigfive-test/
const BASE = process.env.VITE_BASE_PATH || '/';

export default defineConfig({
  base: BASE,
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4000
  },
  publicDir: 'public',
  plugins: [
    {
      name: 'manifest-base',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'manifest.json',
          source: JSON.stringify({
            name: 'Big Five Personality Test',
            short_name: 'Big Five',
            description: 'Free, offline Big Five personality test. No tracking.',
            start_url: BASE,
            display: 'standalone',
            background_color: '#1a1a2e',
            theme_color: '#1a1a2e'
          }, null, 2)
        });
      }
    },
    {
      name: 'sw-version',
      generateBundle() {
        // Stamp the service worker with a build version so browsers
        // detect a byte-level change and trigger an update check.
        const version = Date.now().toString(36);
        const swSource = readFileSync('public/sw.js', 'utf-8');
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: swSource.replaceAll('__BUILD_VERSION__', version)
        });
      }
    }
  ]
});
