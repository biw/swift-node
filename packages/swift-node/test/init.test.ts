import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'
import { cmdInit } from '../src/cli'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(packageDir, '..', '..')
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

describe('tsdown initialization', () => {
  it('uses the existing project manager for its generated .gitignore', async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-existing-yarn-'))

    try {
      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'existing-yarn-project', packageManager: 'yarn@4.18.0' }),
      )
      await cmdInit(['.'], { cwd: projectDir, interactive: false })

      const gitignore = readFileSync(path.join(projectDir, '.gitignore'), 'utf8')
      expect(gitignore).toContain('node_modules/')
      expect(gitignore).toContain('.pnp.*')
      expect(gitignore).toContain('.yarn/*')
      expect(gitignore).toContain('yarn-debug.log*')
      expect(gitignore).not.toContain('npm-debug.log*')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('scaffolds, installs, and builds a standalone project', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'swift-node-tsdown-init-'))
    const projectDir = path.join(tempDir, 'tsdown-app')

    try {
      await cmdInit(['tsdown-app'], {
        cwd: tempDir,
        interactive: false,
        packageManager: { name: 'npm', version: '11.0.0', source: 'installed' },
        useTsdown: true,
      })

      const packageJsonPath = path.join(projectDir, 'package.json')
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
      const swiftNodeVersion = JSON.parse(
        readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
      ).version
      expect(packageJson.devDependencies).toMatchObject({
        'swift-node': `^${swiftNodeVersion}`,
        'swift-node-unplugin': `^${swiftNodeVersion}`,
        tsdown: '0.22.14',
        typescript: '^6.0.2',
      })
      expect(readFileSync(path.join(projectDir, '.gitignore'), 'utf8')).toContain('dist/')

      // Use the packages being tested instead of requiring an already-published release.
      packageJson.devDependencies['swift-node'] = `file:${packageDir}`
      packageJson.devDependencies['swift-node-unplugin'] = `file:${path.join(
        repoDir,
        'packages',
        'swift-node-unplugin',
      )}`
      writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n')

      execFileSync(command, ['--dir', packageDir, 'build'], { cwd: repoDir, stdio: 'inherit' })
      execFileSync(
        command,
        ['--dir', path.join(repoDir, 'packages', 'swift-node-unplugin'), 'build'],
        {
          cwd: repoDir,
          stdio: 'inherit',
        },
      )
      execFileSync(npmCommand, ['install', '--ignore-scripts'], {
        cwd: projectDir,
        stdio: 'inherit',
      })
      execFileSync(npmCommand, ['run', 'build'], { cwd: projectDir, stdio: 'inherit' })

      expect(existsSync(path.join(projectDir, 'dist', 'index.d.ts'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.d.cts'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.js'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.cjs'))).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 180_000)
})
