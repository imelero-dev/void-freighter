import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8788', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8788', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
