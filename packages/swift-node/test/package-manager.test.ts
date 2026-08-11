import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { findAvailablePackageManagers, inferProjectPackageManager } from '../src/package-manager'

describe('package manager detection', () => {
  it('infers an existing project manager from metadata before lockfiles', () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-package-manager-'))

    try {
      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'example', packageManager: 'yarn@4.18.0' }),
      )
      writeFileSync(path.join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

      expect(inferProjectPackageManager(projectDir)).toBe('yarn')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('infers an existing project manager from its lockfile', () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-package-manager-'))

    try {
      writeFileSync(path.join(projectDir, 'bun.lock'), '')

      expect(inferProjectPackageManager(projectDir)).toBe('bun')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('offers only managers whose version command succeeds', () => {
    const versions: Record<string, string | undefined> = {
      npm: '11.0.0',
      pnpm: '11.20.0',
      bun: undefined,
      corepack: '0.35.0',
    }

    expect(
      findAvailablePackageManagers(
        (name) => versions[name],
        () => '4.18.0',
      ),
    ).toEqual([
      { name: 'npm', version: '11.0.0', source: 'installed' },
      { name: 'yarn', version: '4.18.0', source: 'corepack' },
      { name: 'pnpm', version: '11.20.0', source: 'installed' },
    ])
  })

  it('does not offer Yarn when Corepack is unavailable, even if Yarn Classic is installed', () => {
    const versions: Record<string, string | undefined> = {
      npm: '11.0.0',
      yarn: '1.22.22',
      pnpm: undefined,
      bun: undefined,
      corepack: undefined,
    }

    expect(
      findAvailablePackageManagers(
        (name) => versions[name],
        () => {
          throw new Error('Yarn should not be resolved without Corepack')
        },
      ),
    ).toEqual([{ name: 'npm', version: '11.0.0', source: 'installed' }])
  })
})
