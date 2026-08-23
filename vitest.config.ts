import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Real mod fixtures are CPU and filesystem intensive. Running every file
    // in parallel starves lightweight dynamic-import tests during release CI.
    fileParallelism: false,
  },
})
