import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['cashscript/dist/test/VitestExtensions.js'], testTimeout: 60000 } });
