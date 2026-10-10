import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true, include: ['test/**/*.test.ts'], setupFiles: ['cashscript/dist/test/VitestExtensions.js'], testTimeout: 60000 },
});
