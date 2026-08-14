import { describe, expect, it } from 'vite-plus/test'
import {
  assertPackageVersionsNotLowerThanBaseline,
  assertMatchingPackageVersions,
  assertSwiftNodeUnpluginPeerVersion,
  compareSemanticVersions,
} from '../scripts/check-package-versions.mjs'

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

  it('requires the unplugin peer range to match the release version', () => {
    expect(() =>
      assertSwiftNodeUnpluginPeerVersion([
        { name: 'swift-node', version: '0.1.2' },
        {
          name: 'swift-node-unplugin',
          version: '0.1.2',
          peerDependencies: { 'swift-node': '^0.1.1' },
        },
      ]),
    ).toThrow('peerDependencies.swift-node must be ^0.1.2')

    expect(() =>
      assertSwiftNodeUnpluginPeerVersion([
        { name: 'swift-node', version: '0.1.2' },
        {
          name: 'swift-node-unplugin',
          version: '0.1.2',
          peerDependencies: { 'swift-node': '^0.1.2' },
        },
      ]),
    ).not.toThrow()
  })

  it('compares semantic versions, including prereleases', () => {
    expect(compareSemanticVersions('0.1.4', '0.1.4')).toBe(0)
    expect(compareSemanticVersions('0.1.5', '0.1.4')).toBeGreaterThan(0)
    expect(compareSemanticVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemanticVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0)
    expect(compareSemanticVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
  })

  it('rejects release package versions lower than main', () => {
    expect(() =>
      assertPackageVersionsNotLowerThanBaseline(
        [
          { name: 'swift-node', version: '0.1.3' },
          { name: 'swift-node-unplugin', version: '0.1.3' },
        ],
        [
          { name: 'swift-node', version: '0.1.4' },
          { name: 'swift-node-unplugin', version: '0.1.4' },
        ],
      ),
    ).toThrow(/swift-node: 0\.1\.3 < 0\.1\.4[\s\S]*swift-node-unplugin: 0\.1\.3 < 0\.1\.4/)
  })

  it('accepts release package versions equal to or higher than main', () => {
    expect(() =>
      assertPackageVersionsNotLowerThanBaseline(
        [
          { name: 'swift-node', version: '0.2.0' },
          { name: 'swift-node-unplugin', version: '0.2.0' },
        ],
        [
          { name: 'swift-node', version: '0.1.4' },
          { name: 'swift-node-unplugin', version: '0.1.4' },
        ],
      ),
    ).not.toThrow()
  })
})
