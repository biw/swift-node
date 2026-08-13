import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vite-plus/test'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(rootDir, 'scripts', 'run-without-node-warnings.mjs')

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

  it('propagates the policy to child Node processes', () => {
    const nestedWarning = [
      '-e',
      `const { spawnSync } = require('node:child_process')
const result = spawnSync(process.execPath, ${JSON.stringify(intentionalWarningCommand())}, { stdio: 'inherit' })
process.exit(result.status ?? 1)`,
    ]
    const result = spawnSync(process.execPath, [runner, process.execPath, ...nestedWarning], {
      encoding: 'utf8',
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Node warning promoted to test failure [TESTNODEWARN]')
  })
})
