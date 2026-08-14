// Release-style consumer regression.
//
// This packs the CLI, uses that packed artifact to build a standalone Swift
// project, packages that project with a prebuild only, then installs it into a
// second consumer. Both module systems and the generated declarations must
// work without relying on this workspace's source layout.

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'vite-plus/test'
import { commandInvocation } from './command.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let tmpRoot
let packDir
let addonDir
let consumerDir
const tsgo = path.join(rootDir, 'node_modules', '@typescript', 'native-preview', 'bin', 'tsgo')

function run(cmd, args, cwd = rootDir) {
  const invocation = commandInvocation(cmd, args)
  execFileSync(invocation.command, invocation.args, {
    cwd,
    stdio: 'inherit',
  })
}

function findTarball(prefix) {
  const match = readdirSync(packDir).find(
    (name) => name.startsWith(prefix) && name.endsWith('.tgz'),
  )
  if (!match) throw new Error(`Missing packed tarball for ${prefix}`)
  return path.join(packDir, match)
}

test('installs a packed, prebuild-only addon in ESM and CommonJS consumers', () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'swift-node-packaged-production-'))
  packDir = path.join(tmpRoot, 'packs')
  addonDir = path.join(tmpRoot, 'addon')
  consumerDir = path.join(tmpRoot, 'consumer')

  mkdirSync(packDir, { recursive: true })
  mkdirSync(addonDir, { recursive: true })
  mkdirSync(consumerDir, { recursive: true })

  try {
    run('vp', ['-C', 'packages/swift-node', 'pm', 'pack', '--pack-destination', packDir])
    const swiftNodeTarball = findTarball('swift-node-')

    run('npx', ['--yes', '--package', swiftNodeTarball, 'swift-node', 'init', '.'], addonDir)
    const addonPackagePath = path.join(addonDir, 'package.json')
    const addonPackage = JSON.parse(readFileSync(addonPackagePath, 'utf-8'))
    addonPackage.name = '@matrix/packed-bridge'
    addonPackage.version = '1.0.0'
    addonPackage.files = [
      'dist_swift-node/index.cjs',
      'dist_swift-node/index.mjs',
      'dist_swift-node/index.d.ts',
      'dist_swift-node/index.d.cts',
      'dist_swift-node/index.d.mts',
      process.platform === 'darwin'
        ? `dist_swift-node/*.${process.platform}-${process.arch}.node`
        : `dist_swift-node/${process.platform}-${process.arch}/*.${process.platform}-${process.arch}.node`,
      ...(process.platform === 'linux'
        ? [`dist_swift-node/${process.platform}-${process.arch}/*.so*`]
        : []),
      ...(process.platform === 'win32'
        ? [`dist_swift-node/${process.platform}-${process.arch}/*.dll`]
        : []),
      'src/',
    ]
    writeFileSync(addonPackagePath, JSON.stringify(addonPackage, null, 2) + '\n')

    writeFileSync(
      path.join(addonDir, 'src', 'native.swift'),
      `import Foundation

public struct Profile: Codable, Sendable {
    public let id: Int
    public let name: String
}

// @swift-node:export
func identify(_ value: String) -> String { "packed:" + value }

// @swift-node:export
func add64(_ value: Int64) -> Int64 { value + 1 }

// @swift-node:export
func reverseData(_ value: Data) -> Data { Data(value.reversed()) }

// @swift-node:export
func echoOptional(_ value: String?) -> String? { value }

// @swift-node:export
func rename(_ profile: Profile) -> Profile {
    Profile(id: profile.id + 1, name: profile.name.uppercased())
}
`,
    )

    // The generated build script uses its locally installed swift-node and
    // creates the target-qualified binary that the release workflow packages.
    run('npm', ['install', '--save-dev', swiftNodeTarball], addonDir)
    const applicationDistFile = path.join(addonDir, 'dist', 'application.mjs')
    mkdirSync(path.dirname(applicationDistFile), { recursive: true })
    writeFileSync(applicationDistFile, 'export const applicationBuild = true\n')
    run('npm', ['run', 'build'], addonDir)
    if (existsSync(path.join(addonDir, 'gen')) || existsSync(path.join(addonDir, 'build'))) {
      throw new Error(
        'swift-node build should keep bridge sources and object files out of the project',
      )
    }
    if (readFileSync(applicationDistFile, 'utf-8') !== 'export const applicationBuild = true\n') {
      throw new Error('swift-node build should leave an application-owned dist directory untouched')
    }
    const expectedTargetBinary = path.join(
      addonDir,
      'dist_swift-node',
      ...(process.platform === 'darwin' ? [] : [`${process.platform}-${process.arch}`]),
      `packed_bridge.${process.platform}-${process.arch}.node`,
    )
    if (!readFileSync(expectedTargetBinary).length) {
      throw new Error(`swift-node build should create ${expectedTargetBinary}`)
    }
    run('vp', ['-C', addonDir, 'pm', 'pack', '--pack-destination', packDir])
    const addonTarball = findTarball('matrix-packed-bridge-')
    const addonTarballContents = execFileSync('tar', ['-tzf', addonTarball], { encoding: 'utf8' })
    if (process.platform === 'linux' && !addonTarballContents.includes('libswiftCore.so')) {
      throw new Error('The packed Linux addon must include the Swift runtime sidecars')
    }
    if (process.platform === 'win32' && !addonTarballContents.includes('swiftCore.dll')) {
      throw new Error('The packed Windows addon must include the Swift runtime sidecars')
    }

    writeFileSync(
      path.join(consumerDir, 'package.json'),
      JSON.stringify(
        {
          name: 'swift-node-packed-production-consumer',
          private: true,
          type: 'module',
        },
        null,
        2,
      ) + '\n',
    )
    run('npm', ['install', addonTarball], consumerDir)

    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const addon = await import('@matrix/packed-bridge')
    if (addon.identify('esm') !== 'packed:esm') throw new Error('ESM entrypoint failed')
    if (addon.add64(4_000_000_000) !== 4_000_000_001) throw new Error('ESM Int64 bridge failed')
    if (!addon.reverseData(new Uint8Array([1, 2])).equals(Buffer.from([2, 1]))) throw new Error('ESM binary bridge failed')
    if (addon.echoOptional(null) !== null) throw new Error('ESM optional bridge failed')
    const profile = addon.rename({ id: 41, name: 'ben' })
    if (profile.id !== 42 || profile.name !== 'BEN') throw new Error('ESM struct bridge failed')
  `,
      ],
      consumerDir,
    )

    run(
      process.execPath,
      [
        '-e',
        `
    const addon = require('@matrix/packed-bridge')
    if (addon.identify('cjs') !== 'packed:cjs') throw new Error('CJS entrypoint failed')
    if (addon.add64(4_000_000_000) !== 4_000_000_001) throw new Error('CJS Int64 bridge failed')
    if (!addon.reverseData(new Uint8Array([3, 4])).equals(Buffer.from([4, 3]))) throw new Error('CJS binary bridge failed')
    if (addon.echoOptional(null) !== null) throw new Error('CJS optional bridge failed')
    const profile = addon.rename({ id: 41, name: 'ben' })
    if (profile.id !== 42 || profile.name !== 'BEN') throw new Error('CJS struct bridge failed')
  `,
      ],
      consumerDir,
    )

    writeFileSync(
      path.join(consumerDir, 'type-smoke.ts'),
      `import { add64, echoOptional, identify, rename, reverseData, type Profile } from '@matrix/packed-bridge'

const label: string = identify('typed')
const value: number = add64(4_000_000_000)
const bytes: Uint8Array = reverseData(new Uint8Array([1]))
const optional: string | null = echoOptional(null)
const profile: Profile = rename({ id: 41, name: 'ben' })

void label; void value; void bytes; void optional; void profile

// @ts-expect-error generated Int64 declarations use number
const wrong: string = add64(1)
void wrong
`,
    )
    writeFileSync(
      path.join(consumerDir, 'type-smoke.cjs.cts'),
      `import native = require('@matrix/packed-bridge')

const label: string = native.identify('typed')
const value: number = native.add64(4_000_000_000)
const bytes: Uint8Array = native.reverseData(new Uint8Array([1]))
const optional: string | null = native.echoOptional(null)
const profile: native.Profile = native.rename({ id: 41, name: 'ben' })

void label; void value; void bytes; void optional; void profile

// @ts-expect-error generated Int64 declarations use number
const wrong: string = native.add64(1)
void wrong
`,
    )
    run(
      process.execPath,
      [
        tsgo,
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--strict',
        '--noEmit',
        'type-smoke.ts',
        'type-smoke.cjs.cts',
      ],
      consumerDir,
    )
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}, 180_000)
