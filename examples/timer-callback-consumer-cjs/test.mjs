import { createRequire } from 'node:module'
import { expect, test } from 'vite-plus/test'

const require = createRequire(import.meta.url)
const native = require('@swift-node-examples/timer-callback')

test('the CommonJS consumer receives callback and stream exports', async () => {
  expect(native.greet('CJS')).toBe('Hello, CJS!')
  expect(native.add(10, 20)).toBe(30)

  const tickMessage = await new Promise((resolve) => native.tick(resolve))
  expect(tickMessage).toMatch(/^tick at /)

  const reportMessage = await new Promise((resolve) => native.report(7, resolve, 'cjs'))
  expect(reportMessage).toBe('[cjs] id=7')

  let subscription
  const values = await new Promise((resolve, reject) => {
    const received = []
    subscription = native.streamTicks(
      'cjs',
      2,
      (value) => received.push(value),
      reject,
      () => resolve(received),
    )
  })
  expect(values).toEqual(['cjs:0', 'cjs:1'])
  expect(subscription.closed).toBe(true)
})
