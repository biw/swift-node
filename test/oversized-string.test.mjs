// Large Swift strings must use their explicit byte length at the N-API boundary.
// This builds a tiny addon whose async function returns String(repeating:), asks
// for one character past the limit, and asserts the call rejects while the
// process stays alive.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vite-plus/test'
import { executableForPlatform, executionOptionsForPlatform } from './command.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(rootDir, 'packages', 'swift-node', 'bin', 'swift-node.js')
let tmp

function run(cmd, args, cwd = tmp) {
  execFileSync(executableForPlatform(cmd), args, {
    cwd,
    stdio: 'inherit',
    ...executionOptionsForPlatform(cmd),
  })
}

test('rejects oversized async string returns without crashing', () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'swift-node-oversized-'))
  try {
    run('vp', ['-C', 'packages/swift-node', 'pack'], rootDir)
    run(process.execPath, [cli, 'init', '.'])
    writeFileSync(
      path.join(tmp, 'src', 'native.swift'),
      `import Foundation

// @swift-node:export
func repeatChar(_ count: Int) async -> String {
    return String(repeating: "a", count: count)
}
`,
    )
    run(process.execPath, [cli, 'build'])

    const entry = pathToFileURL(path.join(tmp, 'dist_swift-node', 'index.mjs')).href
    run(process.execPath, [
      '--input-type=module',
      '-e',
      `
    import { constants } from 'node:buffer'
    const { repeatChar } = await import(${JSON.stringify(entry)})
    const tooLong = constants.MAX_STRING_LENGTH + 1

    let rejected = false
    try {
      await repeatChar(tooLong)
    } catch {
      rejected = true
    }
    if (!rejected) {
      console.error('expected an oversized async string return to reject')
      process.exit(1)
    }

    // The addon (and event loop) must still be healthy after the failed conversion.
    const ok = await repeatChar(3)
    if (ok !== 'aaa') {
      console.error('addon unhealthy after a failed conversion, got: ' + ok)
      process.exit(1)
    }
    console.log('oversized string return rejected gracefully; process exited normally')
  `,
    ])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}, 180_000)
