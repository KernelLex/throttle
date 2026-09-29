import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    port: 5173,
    // Fail loudly rather than silently moving to 5174 — the API's CORS allowlist and
    // the Google OAuth redirect URI are both pinned to 5173, so a silent port change
    // produces a confusing "login just doesn't work" instead of a clear error.
    strictPort: true,
  },

  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing dependencies out of the app bundle so a
        // code change does not force users to re-download React and Recharts.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
        },
      },
    },
  },
});
