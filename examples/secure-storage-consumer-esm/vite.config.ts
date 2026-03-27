import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['src/secure-storage.test.ts'],
  },
})
