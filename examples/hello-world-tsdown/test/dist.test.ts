import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { helloWorld } from '../dist/index.js'

describe('hello-world-tsdown', () => {
  it('bundles the Swift runtime and emits its target-qualified native asset', () => {
    expect(helloWorld()).toBe('Hello, World from tsdown!')
    expect(existsSync(path.join(import.meta.dirname, '..', 'dist', 'index.cjs'))).toBe(true)
    expect(existsSync(path.join(import.meta.dirname, '..', 'dist', 'index.d.ts'))).toBe(true)
    expect(
      existsSync(
        path.join(
          import.meta.dirname,
          '..',
          'dist',
          `${process.platform}-${process.arch}`,
          `hello_world_tsdown.${process.platform}-${process.arch}.node`,
        ),
      ),
    ).toBe(true)
  })
})
