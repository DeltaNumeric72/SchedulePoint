import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'gates',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
