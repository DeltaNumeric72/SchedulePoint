import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
  },
  preview: {
    // Bind the loopback IPv4 address explicitly. `localhost` can resolve to ::1
    // only, and Playwright's webServer readiness probe targets 127.0.0.1.
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
