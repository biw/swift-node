import { describe, it, expect } from 'vite-plus/test'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const addon = require(
  path.join(
    __dirname,
    '..',
    'dist_swift-node',
    ...(process.platform === 'darwin' ? [] : [`${process.platform}-${process.arch}`]),
    `timer_callback.${process.platform}-${process.arch}.node`,
  ),
)

describe('timer-callback', () => {
  describe('greet (String -> String)', () => {
    it('greets by name', () => {
      expect(addon.greet('World')).toBe('Hello, World!')
    })

    it('greets with different name', () => {
      expect(addon.greet('Swift')).toBe('Hello, Swift!')
    })

    it('handles empty string', () => {
      expect(addon.greet('')).toBe('Hello, !')
    })
  })

  describe('add (Int -> Int)', () => {
    it('adds positive numbers', () => {
      expect(addon.add(2, 3)).toBe(5)
    })

    it('handles negative numbers', () => {
      expect(addon.add(-1, 1)).toBe(0)
    })

    it('handles zeros', () => {
      expect(addon.add(0, 0)).toBe(0)
    })

    it('handles hundreds', () => {
      expect(addon.add(100, 200)).toBe(300)
    })

    it('handles large numbers', () => {
      expect(addon.add(1000000, 2000000)).toBe(3000000)
    })

    it('handles 64-bit sized integers', () => {
      expect(addon.add(3000000000, 2000000000)).toBe(5000000000)
    })
  })

  describe('tick (callback)', () => {
    it('calls the callback with a string', async () => {
      const result = await new Promise<string>((resolve) => {
        addon.tick((msg: string) => {
          resolve(msg)
        })
      })

      expect(typeof result).toBe('string')
      expect(result.startsWith('tick at')).toBe(true)
    })
  })

  describe('report (callback that is not the last parameter)', () => {
    it('invokes a mid-signature callback with the surrounding args intact', async () => {
      const result = await new Promise<string>((resolve) => {
        addon.report(7, (msg: string) => resolve(msg), 'sync')
      })
      expect(result).toBe('[sync] id=7')
    })
  })

  describe('callback argument bridging', () => {
    it('passes mixed string and scalar callback arguments', async () => {
      const result = await new Promise<string>((resolve) => {
        addon.reportMany((left: string, count: number, right: string) => {
          resolve(`${left}:${count}:${right}`)
        })
      })
      expect(result).toBe('left:42:right')
    })

    it('passes Bool and Double callback arguments', async () => {
      const result = await new Promise<[boolean, number]>((resolve) => {
        addon.reportMeasurement((enabled: boolean, ratio: number) => resolve([enabled, ratio]))
      })

      expect(result).toEqual([true, 2.5])
    })

    it('passes nullable string callback arguments', async () => {
      const present = await new Promise<string | null>((resolve) => {
        addon.reportOptional(true, (value: string | null) => resolve(value))
      })
      const missing = await new Promise<string | null>((resolve) => {
        addon.reportOptional(false, (value: string | null) => resolve(value))
      })

      expect(present).toBe('value')
      expect(missing).toBeNull()
    })

    it('accepts nullable string inputs on callback-bearing functions', async () => {
      const tagged = await new Promise<string>((resolve) => {
        addon.reportTag('custom', (msg: string) => resolve(msg))
      })
      const fallback = await new Promise<string>((resolve) => {
        addon.reportTag(null, (msg: string) => resolve(msg))
      })

      expect(tagged).toBe('custom')
      expect(fallback).toBe('none')
    })
  })

  describe('async Promise callbacks', () => {
    it('awaits a JavaScript Promise before resuming Swift', async () => {
      addon.installPromiseCallback(async (value: string) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return value.toUpperCase()
      })

      const result = await new Promise<string>((resolve) => {
        addon.invokeInstalledPromiseCallback('swift-node', resolve)
      })

      expect(result).toBe('SWIFT-NODE')
      addon.clearPromiseCallback()
    })

    it('keeps concurrent Promise callbacks isolated', async () => {
      addon.installPromiseCallback(async (value: string) => {
        await new Promise((resolve) => setTimeout(resolve, value === 'slow' ? 15 : 1))
        return `${value}:done`
      })

      const invoke = (value: string): Promise<string> =>
        new Promise((resolve) => addon.invokeInstalledPromiseCallback(value, resolve))

      await expect(Promise.all([invoke('slow'), invoke('fast')])).resolves.toEqual([
        'slow:done',
        'fast:done',
      ])
      addon.clearPromiseCallback()
    })

    it('propagates JavaScript Promise rejection back to Swift', async () => {
      addon.installPromiseCallback(async () => {
        throw new Error('handler failed')
      })

      const result = await new Promise<string>((resolve) => {
        addon.invokeInstalledPromiseCallback('input', resolve)
      })

      expect(result).toContain('handler failed')
      addon.clearPromiseCallback()
    })
  })

  describe('concurrent cancellable streams', () => {
    it('keeps simultaneous subscriptions isolated and closes each on completion', async () => {
      const left: string[] = []
      const right: string[] = []
      let leftSubscription: { readonly closed: boolean }
      let rightSubscription: { readonly closed: boolean }

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          leftSubscription = addon.streamTicks(
            'left',
            3,
            (value: string) => left.push(value),
            reject,
            resolve,
          )
        }),
        new Promise<void>((resolve, reject) => {
          rightSubscription = addon.streamTicks(
            'right',
            2,
            (value: string) => right.push(value),
            reject,
            resolve,
          )
        }),
      ])

      expect(left).toEqual(['left:0', 'left:1', 'left:2'])
      expect(right).toEqual(['right:0', 'right:1'])
      expect(leftSubscription!.closed).toBe(true)
      expect(rightSubscription!.closed).toBe(true)
    })

    it('cancels an individual stream without affecting another subscription', async () => {
      const cancelled: string[] = []
      const completed: string[] = []
      let subscription:
        | { cancel(): void; readonly closed: boolean; [Symbol.dispose](): void }
        | undefined
      let completedSubscription: { readonly closed: boolean } | undefined

      const completedStream = new Promise<void>((resolve, reject) => {
        completedSubscription = addon.streamTicks(
          'complete',
          2,
          (value: string) => completed.push(value),
          reject,
          resolve,
        )
      })
      await new Promise<void>((resolve) => {
        subscription = addon.streamUntilCancelled('cancel', (value: string) => {
          cancelled.push(value)
          if (cancelled.length === 1) {
            subscription![Symbol.dispose]()
            resolve()
          }
        })
      })
      const countAtCancellation = cancelled.length
      await new Promise((resolve) => setTimeout(resolve, 60))

      expect(subscription!.closed).toBe(true)
      expect(cancelled).toHaveLength(countAtCancellation)
      await completedStream
      expect(completed).toEqual(['complete:0', 'complete:1'])
      expect(completedSubscription!.closed).toBe(true)
    })

    it('delivers stream failures once and does not report normal completion', async () => {
      const values: string[] = []
      let subscription: { readonly closed: boolean } | undefined
      const error = await new Promise<Error>((resolve, reject) => {
        subscription = addon.streamFailure(
          (value: string) => values.push(value),
          resolve,
          () => reject(new Error('unexpected completion')),
        )
      })

      expect(values).toEqual(['before-error'])
      expect(error.message).toBe('expected stream failure')
      expect(subscription!.closed).toBe(true)
    })

    it('cleans live subscriptions during addon teardown', () => {
      const script = `
        const addon = require(${JSON.stringify(path.join(__dirname, '..', 'dist_swift-node', ...(process.platform === 'darwin' ? [] : [`${process.platform}-${process.arch}`]), `timer_callback.${process.platform}-${process.arch}.node`))})
        let events = 0
        addon.streamUntilCancelled('teardown', () => { events += 1 })
        global.gc()
        setTimeout(() => {
          if (events > 1) throw new Error('garbage-collected subscription remained active')
          process.exit(0)
        }, 60)
      `

      expect(() =>
        execFileSync(process.execPath, ['--expose-gc', '-e', script], { timeout: 2_000 }),
      ).not.toThrow()
    })
  })
})
