import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: '.',
  test: { include: ['src/**/*.test.ts', 'web/**/*.test.ts'], environment: 'node' },
});
