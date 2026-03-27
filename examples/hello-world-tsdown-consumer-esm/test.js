import { helloWorld } from '@swift-node-examples/hello-world-tsdown'
import { expect, test } from 'vite-plus/test'

test('the ESM consumer loads the tsdown-bundled addon', () => {
  expect(helloWorld()).toBe('Hello, World from tsdown!')
})
