import { describe, it, expect, afterAll } from 'vite-plus/test'
import { delete as del, setServiceName, set, get } from '@swift-node-examples/secure-storage'

const TEST_SERVICE = 'swift-node-vite-plus-' + Date.now()
setServiceName(TEST_SERVICE)

// Track all keys so we can clean up even if tests fail
const keysToCleanup: string[] = []

function track(key: string) {
  if (!keysToCleanup.includes(key)) keysToCleanup.push(key)
  return key
}

afterAll(() => {
  for (const key of keysToCleanup) {
    del(key)
  }
})

describe('secure-storage', () => {
  describe('set + get', () => {
    it('stores and retrieves a value', () => {
      expect(set(track('key1'), 'value1')).toBe(true)
      expect(get('key1')).toBe('value1')
    })

    it('overwrites an existing value', () => {
      set(track('key1'), 'updated')
      expect(get('key1')).toBe('updated')
    })
  })

  describe('get missing key', () => {
    it("returns null for a key that doesn't exist", () => {
      expect(get('no-such-key')).toBeNull()
    })
  })

  describe('delete', () => {
    it('deletes an existing key', () => {
      set(track('to-delete'), 'temporary')
      expect(del('to-delete')).toBe(true)
      expect(get('to-delete')).toBeNull()
    })

    it('returns true for a non-existent key', () => {
      expect(del('never-existed')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('handles empty string values', () => {
      set(track('empty'), '')
      expect(get('empty')).toBe('')
    })

    it('handles unicode values', () => {
      set(track('special'), 'héllo wörld 🔑')
      expect(get('special')).toBe('héllo wörld 🔑')
    })

    it('handles 10k character values', () => {
      const longValue = 'x'.repeat(10_000)
      set(track('long'), longValue)
      expect(get('long')).toBe(longValue)
    })
  })
})
