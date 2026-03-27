import { describe, expect, it } from 'vite-plus/test'
import { helloWorld } from '../dist_swift-node/index.mjs'

describe('hello-world', () => {
  it('exports a Swift helloWorld function', () => {
    expect(helloWorld()).toBe('Hello, World!')
  })
})
