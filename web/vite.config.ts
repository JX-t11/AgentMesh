import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:18890';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 18891,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        ws: true,
      },
      '/docs': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/testSetup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.test.*', 'src/testSetup.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
