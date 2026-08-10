import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vite-plus/test'
import { executableForPlatform, executionOptionsForPlatform } from './command.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmpRoot
let packDir
let appDir

function run(cmd, args, cwd = rootDir) {
  execFileSync(executableForPlatform(cmd), args, {
    cwd,
    stdio: 'inherit',
    ...executionOptionsForPlatform(cmd),
  })
}

function findTarball(prefix) {
  const match = readdirSync(packDir).find(
    (name) => name.startsWith(prefix) && name.endsWith('.tgz'),
  )
  if (!match) {
    throw new Error(`Missing packed tarball for ${prefix}`)
  }
  return path.join(packDir, match)
}

function runTypeScriptSmoke() {
  const tsgo = path.join(rootDir, 'node_modules', '.bin', 'tsgo')
  writeFileSync(
    path.join(appDir, 'type-smoke.ts'),
    `
import { helloWorld } from '@swift-node-examples/hello-world'

const greeting: string = helloWorld()

if (!greeting) {
  throw new Error('keep values used')
}

// @ts-expect-error helloWorld does not accept arguments
helloWorld('unexpected')
`,
  )
  writeFileSync(
    path.join(appDir, 'type-smoke-cjs.cts'),
    `
import native = require('@swift-node-examples/hello-world')

const greeting: string = native.helloWorld()

if (!greeting) {
  throw new Error('keep values used')
}

// @ts-expect-error helloWorld does not accept arguments
native.helloWorld('unexpected')
`,
  )
  run(
    tsgo,
    [
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--strict',
      '--noEmit',
      'type-smoke.ts',
      'type-smoke-cjs.cts',
    ],
    appDir,
  )
}

test('loads the packaged hello-world addon from its target-qualified native entry', () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'swift-node-packaged-'))
  packDir = path.join(tmpRoot, 'packs')
  appDir = path.join(tmpRoot, 'app')

  mkdirSync(packDir, { recursive: true })
  mkdirSync(appDir, { recursive: true })

  try {
    run('vp', ['-C', 'packages/swift-node', 'pack'])
    run('vp', ['-C', 'examples/hello-world', 'run', 'build'])
    run('vp', ['-C', 'examples/hello-world', 'pm', 'pack', '--pack-destination', packDir])

    writeFileSync(
      path.join(appDir, 'package.json'),
      JSON.stringify(
        {
          name: 'swift-node-packaged-smoke',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
    )

    const helloWorldTarball = findTarball('swift-node-examples-hello-world-')

    run('npm', ['install', helloWorldTarball], appDir)

    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const { helloWorld } = await import('@swift-node-examples/hello-world')
    if (helloWorld() !== 'Hello, World!') process.exit(1)
  `,
      ],
      appDir,
    )

    run(
      process.execPath,
      [
        '-e',
        `
    const native = require('@swift-node-examples/hello-world')
    if (native.helloWorld() !== 'Hello, World!') process.exit(1)
  `,
      ],
      appDir,
    )
    runTypeScriptSmoke()

    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const { helloWorld } = await import('@swift-node-examples/hello-world')
    if (helloWorld() !== 'Hello, World!') process.exit(1)
  `,
      ],
      appDir,
    )

    run(
      process.execPath,
      [
        '-e',
        `
    const native = require('@swift-node-examples/hello-world')
    if (native.helloWorld() !== 'Hello, World!') process.exit(1)
  `,
      ],
      appDir,
    )
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}, 180_000)
