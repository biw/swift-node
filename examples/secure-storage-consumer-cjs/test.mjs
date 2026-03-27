import { createRequire } from 'node:module'
import { expect, test } from 'vite-plus/test'

const require = createRequire(import.meta.url)
const native = require('@swift-node-examples/secure-storage')

test('the CommonJS consumer uses secure storage through generated bindings', () => {
  native.setServiceName(`swift-node-cjs-demo-${Date.now()}`)

  expect(native.set('cjs-key', 'cjs-value')).toBe(true)
  expect(native.get('cjs-key')).toBe('cjs-value')
  expect(native.delete('cjs-key')).toBe(true)
  expect(native.get('cjs-key')).toBeNull()
})
