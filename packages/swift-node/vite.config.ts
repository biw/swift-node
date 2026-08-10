import { defineConfig } from 'vite-plus'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  pack: {
    // Keep the executable and its test helper as stable package entrypoints.
    entry: ['src/cli.ts', 'src/command.ts'],
    format: 'esm',
    platform: 'node',
    // The package is ESM, but its bin wrapper and project tooling already use
    // the conventional .js filenames rather than tsdown's Node .mjs default.
    fixedExtension: false,
    dts: {
      generator: 'tsgo',
    },
    sourcemap: true,
    deps: {
      neverBundle: true,
    },
  },
})
