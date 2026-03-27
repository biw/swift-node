import { describe, it, expect, beforeAll } from 'vite-plus/test'
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
    `${process.platform}-${process.arch}`,
    `secure_storage.${process.platform}-${process.arch}.node`,
  ),
)

describe('secure-storage', () => {
  beforeAll(() => {
    // Set service name so Keychain works outside a bundle
    addon.setServiceName('swift-node-test')
  })

  it('sets a value', () => {
    const ok = addon.set('test-key', 'hello from swift-node!')
    expect(ok).toBe(true)
  })

  it('gets the stored value back', () => {
    addon.set('test-key', 'hello from swift-node!')
    const val = addon.get('test-key')
    expect(val).toBe('hello from swift-node!')
  })

  it('returns null for non-existent key', () => {
    const missing = addon.get('no-such-key-' + Date.now())
    expect(missing).toBeNull()
  })

  it('deletes a key', () => {
    addon.set('delete-me', 'temp')
    const del = addon.delete('delete-me')
    expect(del).toBe(true)
  })

  it('returns null after deletion', () => {
    addon.set('delete-me-2', 'temp')
    addon.delete('delete-me-2')
    const gone = addon.get('delete-me-2')
    expect(gone).toBeNull()
  })

  it('overwrites existing values', () => {
    addon.set('overwrite-key', 'first')
    addon.set('overwrite-key', 'second')
    expect(addon.get('overwrite-key')).toBe('second')
    addon.delete('overwrite-key')
  })

  it('handles special characters in values', () => {
    addon.set('special-key', 'hello "world" & <friends>')
    expect(addon.get('special-key')).toBe('hello "world" & <friends>')
    addon.delete('special-key')
  })
})
