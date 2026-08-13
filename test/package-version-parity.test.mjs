import { describe, expect, it } from 'vite-plus/test'
import { assertMatchingPackageVersions } from '../scripts/check-package-versions.mjs'

describe('release package version parity', () => {
  it('accepts matching package versions', () => {
    expect(
      assertMatchingPackageVersions([
        { name: 'swift-node', version: '0.1.2' },
        { name: 'swift-node-unplugin', version: '0.1.2' },
      ]),
    ).toBe('0.1.2')
  })

  it('reports every package when versions differ', () => {
    expect(() =>
      assertMatchingPackageVersions([
        { name: 'swift-node', version: '0.1.2' },
        { name: 'swift-node-unplugin', version: '0.1.1' },
      ]),
    ).toThrow(/swift-node: 0\.1\.2[\s\S]*swift-node-unplugin: 0\.1\.1/)
  })
})
