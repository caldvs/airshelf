import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest 4.x is ESM-only and the project is CommonJS, so test files use
    // .mjs to opt into ESM without flipping the whole package to type:module.
    include: ['**/*.test.mjs'],
  },
});
