import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: { reporter: ['text', 'json-summary'] },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
});
