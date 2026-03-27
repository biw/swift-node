import { helloWorld } from '@swift-node-examples/hello-world'
import { expect, test } from 'vite-plus/test'

test('the ESM consumer loads the hello-world addon', () => {
  expect(helloWorld()).toBe('Hello, World!')
})
