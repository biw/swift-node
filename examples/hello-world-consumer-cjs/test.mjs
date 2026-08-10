import { createRequire } from 'node:module'
import { expect, test } from 'vite-plus/test'

const require = createRequire(import.meta.url)
const native = require('@swift-node-examples/hello-world')

test('the CommonJS consumer loads the hello-world addon', () => {
  expect(native.helloWorld()).toBe('Hello, World!')
})
