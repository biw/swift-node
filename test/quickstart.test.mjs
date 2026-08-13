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
let appParentDir
let appDir
let inPlaceDir
let missingNameDir

function run(cmd, args, cwd = rootDir) {
  const invocation = commandInvocation(cmd, args)
  execFileSync(invocation.command, invocation.args, {
    cwd,
    stdio: 'inherit',
  })
}

function runAndCaptureFailure(cmd, args, cwd = rootDir) {
  const invocation = commandInvocation(cmd, args)
  try {
    execFileSync(invocation.command, invocation.args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  throw new Error(`${cmd} ${args.join(' ')} unexpectedly succeeded`)
}

function findTarball(prefix) {
  const match = readdirSync(packDir).find(
    (name) => name.startsWith(prefix) && name.endsWith('.tgz'),
  )
  if (!match) throw new Error(`Missing packed tarball for ${prefix}`)
  return path.join(packDir, match)
}

function runTypeScriptSmoke() {
  const tsgo = path.join(rootDir, 'node_modules', '@typescript', 'native-preview', 'bin', 'tsgo')
  writeFileSync(
    path.join(appDir, 'type-smoke.ts'),
    `
import { greet, rename, type Profile } from 'app'

const profile: Profile = { id: 41, name: 'ben' }
const renamed: Profile = rename(profile)
const greeting: string = greet(renamed.name)

if (!greeting || renamed.id !== 42) {
  throw new Error('keep values used')
}

// @ts-expect-error Profile.id must be a number
const wrong: Profile = { id: '41', name: 'ben' }
void wrong
`,
  )
  writeFileSync(
    path.join(appDir, 'type-smoke-cjs.cts'),
    `
import native = require('app')

const profile: native.Profile = { id: 41, name: 'ben' }
const renamed: native.Profile = native.rename(profile)
const greeting: string = native.greet(renamed.name)

if (!greeting || renamed.id !== 42) {
  throw new Error('keep values used')
}

// @ts-expect-error Profile.name must be a string
const wrong: native.Profile = { id: 41, name: 123 }
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
      'type-smoke-cjs.cts',
    ],
    appDir,
  )
}

test('initializes and builds a project from the packaged CLI', () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'swift-node-quickstart-'))
  packDir = path.join(tmpRoot, 'packs')
  appParentDir = path.join(tmpRoot, 'project-root')
  appDir = path.join(appParentDir, 'app')
  inPlaceDir = path.join(tmpRoot, 'in-place-addon')
  missingNameDir = path.join(tmpRoot, 'missing-name')

  mkdirSync(packDir, { recursive: true })
  mkdirSync(appParentDir, { recursive: true })
  mkdirSync(inPlaceDir, { recursive: true })
  mkdirSync(missingNameDir, { recursive: true })

  try {
    run('vp', ['-C', 'packages/swift-node', 'pack'])
    run('vp', ['-C', 'packages/swift-node', 'pm', 'pack', '--pack-destination', packDir])
    const swiftNodeTarball = findTarball('swift-node-')
    const tarballContents = execFileSync('tar', ['-tzf', swiftNodeTarball], { encoding: 'utf8' })
    if (tarballContents.includes('package/swift-node-loader/')) {
      throw new Error('swift-node package must not ship a standalone runtime loader')
    }

    const missingNameOutput = runAndCaptureFailure(
      'npx',
      ['--yes', '--package', swiftNodeTarball, 'swift-node', 'init'],
      missingNameDir,
    )
    if (!missingNameOutput.includes('A package name is required in a non-interactive terminal')) {
      throw new Error(
        'swift-node init without a package name should explain how non-interactive callers can proceed',
      )
    }

    run('npx', ['--yes', '--package', swiftNodeTarball, 'swift-node', 'init', '.'], inPlaceDir)
    const inPlacePackage = JSON.parse(readFileSync(path.join(inPlaceDir, 'package.json'), 'utf-8'))
    if (
      inPlacePackage.name !== 'in-place-addon' ||
      !existsSync(path.join(inPlaceDir, 'src', 'native.swift'))
    ) {
      throw new Error(
        'swift-node init . should initialize the current directory with its directory name and starter source',
      )
    }
    if (existsSync(path.join(inPlaceDir, 'in-place-addon'))) {
      throw new Error('swift-node init . should not create a nested project directory')
    }

    run('npx', ['--yes', '--package', swiftNodeTarball, 'swift-node', 'init', 'app'], appParentDir)
    if (!existsSync(appDir) || !existsSync(path.join(appDir, 'src', 'native.swift'))) {
      throw new Error(
        'swift-node init <package-name> should create a project directory with starter source',
      )
    }
    const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf-8'))
    if (
      pkg.name !== 'app' ||
      pkg.type !== 'module' ||
      pkg.types !== './dist_swift-node/index.d.ts' ||
      pkg.main !== './dist_swift-node/index.cjs'
    ) {
      throw new Error('swift-node init should create package entrypoint metadata')
    }
    if (pkg.dependencies || Object.keys(pkg.devDependencies ?? {}).join(',') !== 'swift-node') {
      throw new Error('swift-node init should declare only swift-node as a development dependency')
    }
    if (pkg.scripts?.build !== 'swift-node build' || Object.keys(pkg.scripts).length !== 1) {
      throw new Error('swift-node init should create a conventional local swift-node build script')
    }
    if (pkg.swiftNode?.shipSwiftRuntime !== true) {
      throw new Error('swift-node init should ship Linux and Windows Swift runtimes by default')
    }
    if (
      existsSync(path.join(appDir, 'vite.config.ts')) ||
      !existsSync(path.join(appDir, 'src', 'index.ts'))
    ) {
      throw new Error(
        'swift-node init should create a source entry point without imposing an application toolchain',
      )
    }
    if (existsSync(path.join(appDir, '.github', 'workflows', 'publish.yml'))) {
      throw new Error('non-interactive swift-node init should remain local-build only')
    }
    if (
      pkg.exports?.['.']?.import?.types !== './dist_swift-node/index.d.mts' ||
      pkg.exports?.['.']?.import?.default !== './dist_swift-node/index.mjs' ||
      pkg.exports?.['.']?.require?.types !== './dist_swift-node/index.d.cts' ||
      pkg.exports?.['.']?.require?.default !== './dist_swift-node/index.cjs'
    ) {
      throw new Error('swift-node init should create conditional ESM/CJS exports')
    }
    const gitignorePath = path.join(appDir, '.gitignore')
    if (!existsSync(gitignorePath)) {
      throw new Error('swift-node init should create a .gitignore')
    }
    const gitignore = readFileSync(gitignorePath, 'utf-8')
    for (const output of ['node_modules/', 'dist_swift-node/']) {
      if (!gitignore.split(/\r?\n/).includes(output)) {
        throw new Error(`swift-node init should ignore ${output}`)
      }
    }
    const starterSource = readFileSync(path.join(appDir, 'src', 'native.swift'), 'utf-8')
    if (
      starterSource !==
      '// @swift-node:export\nfunc helloWorld() -> String {\n    "Hello, World!"\n}\n'
    ) {
      throw new Error('swift-node init should create the documented hello-world starter export')
    }
    writeFileSync(
      path.join(appDir, 'src', 'native.swift'),
      `import Foundation

public struct Profile: Codable, Sendable {
    public let id: Int
    public let name: String
}

// @swift-node:export
func greet(_ name: String) -> String {
    return "Hello, \\(name)!"
}

// @swift-node:export
func rename(_ profile: Profile) -> Profile {
    return Profile(id: profile.id + 1, name: profile.name.uppercased())
}
`,
    )
    const applicationDistFile = path.join(appDir, 'dist', 'app.mjs')
    mkdirSync(path.dirname(applicationDistFile), { recursive: true })
    writeFileSync(applicationDistFile, 'export const applicationBuild = true\n')
    run('npx', ['--yes', '--package', swiftNodeTarball, 'swift-node', 'build'], appDir)
    if (existsSync(path.join(appDir, 'gen')) || existsSync(path.join(appDir, 'build'))) {
      throw new Error(
        'swift-node build should keep bridge sources and object files out of the project',
      )
    }
    for (const output of ['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.cts', 'index.d.mts']) {
      if (!existsSync(path.join(appDir, 'dist_swift-node', output))) {
        throw new Error(`swift-node build should create dist_swift-node/${output}`)
      }
    }
    if (readFileSync(applicationDistFile, 'utf-8') !== 'export const applicationBuild = true\n') {
      throw new Error('swift-node build should leave an application-owned dist directory untouched')
    }
    const targetBinary = path.join(
      appDir,
      'dist_swift-node',
      ...(process.platform === 'darwin' ? [] : [`${process.platform}-${process.arch}`]),
      `app.${process.platform}-${process.arch}.node`,
    )
    if (!readFileSync(targetBinary).length) {
      throw new Error(`swift-node build should create ${targetBinary}`)
    }
    runTypeScriptSmoke()
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const { greet, rename } = await import('./dist_swift-node/index.mjs')
    if (greet('World') !== 'Hello, World!') process.exit(1)
    const profile = rename({ id: 41, name: 'ben' })
    if (profile.id !== 42 || profile.name !== 'BEN') process.exit(1)
  `,
      ],
      appDir,
    )
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}, 180_000)
