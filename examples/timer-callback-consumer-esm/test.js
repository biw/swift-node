import { add, greet, report, streamTicks, tick } from '@swift-node-examples/timer-callback'
import { expect, test } from 'vite-plus/test'

test('the ESM consumer receives callback and stream exports', async () => {
  expect(greet('ESM')).toBe('Hello, ESM!')
  expect(add(10, 20)).toBe(30)

  const tickMessage = await new Promise((resolve) => tick(resolve))
  expect(tickMessage).toMatch(/^tick at /)

  const reportMessage = await new Promise((resolve) => report(7, resolve, 'esm'))
  expect(reportMessage).toBe('[esm] id=7')

  let subscription
  const values = await new Promise((resolve, reject) => {
    const received = []
    subscription = streamTicks(
      'esm',
      2,
      (value) => received.push(value),
      reject,
      () => resolve(received),
    )
  })
  expect(values).toEqual(['esm:0', 'esm:1'])
  expect(subscription.closed).toBe(true)
})
