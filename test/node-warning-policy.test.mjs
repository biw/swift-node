import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(rootDir, 'scripts', 'run-without-node-warnings.mjs')
const ciConfigurator = path.join(rootDir, 'scripts', 'configure-node-warning-policy.mjs')

function intentionalWarningCommand() {
  return [
    '-e',
    "process.emitWarning('intentional warning-policy regression', { code: 'TESTNODEWARN' })",
  ]
}

describe('Node warning policy', () => {
  it('fails a child process for every Node process warning', () => {
    const result = spawnSync(
      process.execPath,
      [runner, process.execPath, ...intentionalWarningCommand()],
      { encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Node warning promoted to test failure [TESTNODEWARN]')
  })

  it('writes the same policy for every subsequent CI step', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'swift-node-warning-policy-'))
    const environmentFile = path.join(tempDir, 'github-env')

    try {
      const configured = spawnSync(process.execPath, [ciConfigurator], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_ENV: environmentFile },
      })
      expect(configured.status).toBe(0)

      const nodeOptions = readFileSync(environmentFile, 'utf8').trim().slice('NODE_OPTIONS='.length)
      const result = spawnSync(process.execPath, intentionalWarningCommand(), {
        encoding: 'utf8',
        env: { ...process.env, NODE_OPTIONS: nodeOptions },
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Node warning promoted to test failure [TESTNODEWARN]')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
