import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:4573' },
    fs: { allow: ['..'] }, // shared types live in ../src/shared
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
  // monaco-editor ships as static files in public/vs (see scripts/copy-monaco.mjs);
  // keep the npm package out of the dep optimizer and the bundle.
  optimizeDeps: { exclude: ['monaco-editor'] },
});
