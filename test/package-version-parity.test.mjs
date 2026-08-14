import { describe, expect, it } from 'vite-plus/test'
import {
  assertMatchingPackageVersions,
  assertSwiftNodeUnpluginPeerVersion,
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
})
