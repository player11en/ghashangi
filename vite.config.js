import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` / `preview:https` pass --mode https. WebXR requires a
// secure context, so testing AR on a real phone over the LAN needs TLS.
export default defineConfig(({ mode }) => ({
  // Relative base so dist/ works from a subpath (GitHub Pages, a CDN folder)
  // as well as from a domain root.
  base: './',

  plugins: mode === 'https' ? [basicSsl()] : [],

  build: {
    target: 'esnext',
    sourcemap: true,
    // three is large; the warning fires on every build and tells us nothing
    // we are not already handling via manualChunks.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Keep three's core in one long-lived chunk, and split the per-format
        // parsers out so a visit that only opens a .glb never downloads the
        // FBX or USD parsers. Each of these is dynamically imported from
        // src/loaders/index.js, so Rollup can honour the split.
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },

  worker: {
    format: 'es',
  },

  server: {
    // Large model files over the LAN; Vite's default is fine but be explicit
    // that we want the host exposed when --host is passed.
    fs: { strict: true },
  },
}));
