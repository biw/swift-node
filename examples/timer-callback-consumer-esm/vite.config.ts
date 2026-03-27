import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['test.js'],
    // Node-API callbacks must run in a process rather than a worker thread.
    pool: 'forks',
  },
})
