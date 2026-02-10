// Vitest configuration for zele.
// Scoped to src/ to avoid picking up opensrc/ test files.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
