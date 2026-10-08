import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // Real PBKDF2 operations can exceed five seconds when crypto suites run together.
  test: { testTimeout: 15000 },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }
});
