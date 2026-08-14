import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

test('initializes package-name and in-place projects from the packaged CLI', () => {
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
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}, 90_000)
