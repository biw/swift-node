#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  lstatSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { execFileSync, execSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
import { readConfig } from './config.js'
import {
  parseSwiftStructs,
  parseExportedFunctions,
  parseSwiftGlobalActorNames,
  parseSwiftCodableTypes,
  SwiftFunction,
  SwiftStruct,
  SwiftCodableType,
} from './parser.js'
import {
  generateAddonCpp,
  generateBridgeH,
  generateDts,
  generateDtsCjs,
  generateStructsHeader,
  generateWrappersSwift,
  exportedToSwiftFunctions,
  generateEntryMjs,
  generateEntryCjs,
  generateSourceEntryTs,
} from './generator.js'
import {
  compileSwift,
  compileCpp,
  getNodeInclude,
  getNodeImportLibrary,
  isSupportedPlatform,
  link,
} from './compiler.js'
import {
  fileHash,
  isNativeBuildUpToDate,
  nativeBuildManifestFilename,
  readNativeBuildManifest,
  type NativeBuildCacheConfiguration,
  writeNativeBuildManifest,
} from './build-cache.js'
import { validateExports } from './validator.js'
import {
  configureYarn,
  findAvailablePackageManagers,
  inferProjectPackageManager,
  PackageManager,
  PackageManagerName,
} from './package-manager.js'
import { gitignoreTemplate } from './gitignore.js'
import { commandInvocationForPlatform } from './command.js'
import {
  generatePrebuildCiWorkflow,
  generatePrebuildWorkflow,
  packageFilesForPrebuildTargets,
  nativeTargetId,
  prebuildFilename,
  selectPrebuildTargets,
  supportedPrebuildTargets,
  type PrebuildTarget,
} from './prebuild.js'

const generatedDirName = 'dist_swift-node'
const generatedRuntimeFiles = ['index.d.ts', 'index.d.cts', 'index.d.mts', 'index.mjs', 'index.cjs']
const nativeBuildLockDirectoryName = '.swift-node-build.lock'
const nativeBuildLockTimeoutMs = 10 * 60 * 1000
const ownerlessNativeBuildLockGraceMs = 1_000
const staleNativeBuildLockMs = 12 * 60 * 60 * 1000
const staleNativeBuildReaperMs = 30_000

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.1'
  } catch {
    return '0.0.1'
  }
}

export async function run(args = process.argv.slice(2)) {
  const command = args[0]
  try {
    switch (command) {
      case 'init':
        await cmdInit(args.slice(1))
        break
      case 'build':
        cmdBuild()
        break
      case 'doctor':
        cmdDoctor()
        break
      default:
        console.log('swift-node — Node-API bridge for Swift')
        console.log('')
        console.log('Commands:')
        console.log('  init [package-name|.]  Create a new swift-node project')
        console.log('  build                Parse, generate, compile, and package the host target')
        console.log('  doctor               Check your toolchain')
        break
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      console.log('\nInitialization cancelled.')
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  void run()
}

function packageNameValidationError(packageName: string): string | undefined {
  if (!packageName) return 'Package name is required.'
  if (packageName !== packageName.trim()) return 'Package name cannot start or end with whitespace.'

  const unscopedName = packageName.startsWith('@')
    ? packageName.match(/^@[a-z0-9][a-z0-9._-]*\/([a-z0-9][a-z0-9._-]*)$/)?.[1]
    : /^[a-z0-9][a-z0-9._-]*$/.exec(packageName)?.[0]

  if (!unscopedName) {
    return 'Use a lowercase npm package name, optionally scoped (for example, my-addon or @scope/my-addon).'
  }
}

function projectDirectoryName(packageName: string): string {
  return packageName.startsWith('@') ? packageName.slice(packageName.indexOf('/') + 1) : packageName
}

function defaultPackageName(directoryName: string): string {
  const normalized = directoryName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
  return normalized || 'swift-node-addon'
}

function packageNameFromExistingProject(projectDir: string): string | undefined {
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) return undefined

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (typeof pkg.name !== 'string' || packageNameValidationError(pkg.name)) {
    throw new Error(`Existing package.json at ${pkgPath} must contain a valid package name.`)
  }
  return pkg.name
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

async function promptForPackageName(defaultName: string): Promise<string> {
  const { input } = await import('@inquirer/prompts')
  return input({
    message: 'Package name:',
    default: defaultName,
    validate: (value) => packageNameValidationError(value) ?? true,
  })
}

async function promptToBuild(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({
    message: 'Install dependencies and build the starter package now?',
    default: true,
  })
}

function runPackageManagerCommand(
  packageManager: PackageManager,
  args: string[],
  projectDir: string,
): void {
  const command = packageManager.source === 'corepack' ? 'corepack' : packageManager.name
  const commandArgs = packageManager.source === 'corepack' ? ['yarn', ...args] : args
  const invocation = commandInvocationForPlatform(command, commandArgs)
  execFileSync(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: 'inherit',
  })
}

async function promptToUseTsdown(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({
    message: 'Set up tsdown to package this module’s TypeScript?',
    default: true,
  })
}

async function promptForPackageManager(available: PackageManager[]): Promise<PackageManager> {
  const { select } = await import('@inquirer/prompts')
  const selectedName = await select<PackageManagerName>({
    message: 'Which package manager would you like to use for this project?',
    choices: available.map((manager) => ({
      name:
        manager.source === 'corepack'
          ? `Yarn (${manager.version} via Corepack)`
          : `${manager.name} (${manager.version})`,
      value: manager.name,
    })),
  })
  return available.find((manager) => manager.name === selectedName)!
}

async function promptForPrebuildTargets(): Promise<PrebuildTarget[]> {
  const { checkbox } = await import('@inquirer/prompts')
  const selectedIds = await checkbox<string>({
    message: 'Which platforms should receive prebuilt binaries? (optional)',
    choices: supportedPrebuildTargets.map((target) => ({
      name: target.preview ? `${target.label} — GitHub Actions public preview` : target.label,
      value: target.id,
    })),
  })
  return selectPrebuildTargets(selectedIds)
}

async function promptToCreatePrebuildWorkflow(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({
    message: 'Create a GitHub Actions publish workflow that runs after CI succeeds?',
    default: true,
  })
}

async function promptToShipSwiftRuntime(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({
    message: 'Bundle Swift runtime libraries with Linux and Windows prebuilds?',
    default: true,
  })
}

async function promptToPublishPrebuildPackage(): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts')
  return confirm({
    message: 'Make this package publishable and publish it after successful CI on main?',
    default: true,
  })
}

export interface InitOptions {
  buildNow?: boolean
  createPrebuildWorkflow?: boolean
  cwd?: string
  interactive?: boolean
  packageManager?: PackageManager
  prebuildTargets?: PrebuildTarget[]
  publishPrebuildPackage?: boolean
  shipSwiftRuntime?: boolean
  useTsdown?: boolean
}

export async function cmdInit(initArgs: string[], options: InitOptions = {}) {
  if (initArgs.length > 1) {
    throw new Error('Usage: swift-node init [package-name|.]')
  }

  const cwd = options.cwd ?? process.cwd()
  const requestedPackageName = initArgs[0]
  const interactive = options.interactive ?? canPrompt()

  let projectDir = cwd
  let packageName: string

  if (requestedPackageName === '.') {
    packageName =
      packageNameFromExistingProject(projectDir) ?? defaultPackageName(path.basename(cwd))
  } else if (requestedPackageName) {
    const validationError = packageNameValidationError(requestedPackageName)
    if (validationError) throw new Error(validationError)

    projectDir = path.resolve(cwd, projectDirectoryName(requestedPackageName))
    if (path.dirname(projectDir) !== cwd) {
      throw new Error('Package name must create a project directly inside the current directory.')
    }
    if (existsSync(projectDir)) {
      throw new Error(`Cannot create project because ${projectDir} already exists.`)
    }
    packageName = requestedPackageName
  } else {
    packageName = packageNameFromExistingProject(projectDir) ?? ''
    if (!packageName) {
      if (!interactive) {
        throw new Error(
          'A package name is required in a non-interactive terminal. Run "swift-node init <package-name>".',
        )
      }
      packageName = await promptForPackageName(defaultPackageName(path.basename(cwd)))
    }
  }

  const createsPackageManifest = !existsSync(path.join(projectDir, 'package.json'))
  const existingProjectPackageManager = createsPackageManifest
    ? undefined
    : inferProjectPackageManager(projectDir)
  const availablePackageManagers =
    interactive && createsPackageManifest ? findAvailablePackageManagers() : []
  const packageManager =
    options.packageManager ??
    (availablePackageManagers.length > 0
      ? await promptForPackageManager(availablePackageManagers)
      : undefined)
  const useTsdown =
    options.useTsdown ?? (interactive && createsPackageManifest ? await promptToUseTsdown() : false)
  const prebuildTargets =
    options.prebuildTargets ??
    (interactive && createsPackageManifest ? await promptForPrebuildTargets() : [])
  const shipSwiftRuntime =
    options.shipSwiftRuntime ??
    (prebuildTargets.length > 0 ? await promptToShipSwiftRuntime() : true)
  const createPrebuildWorkflow =
    options.createPrebuildWorkflow ??
    (prebuildTargets.length > 0 ? await promptToCreatePrebuildWorkflow() : false)
  const publishPrebuildPackage =
    options.publishPrebuildPackage ??
    (createPrebuildWorkflow ? await promptToPublishPrebuildPackage() : false)
  const buildNow =
    options.buildNow ??
    (interactive && createsPackageManifest && packageManager ? await promptToBuild() : false)

  // Create directories
  mkdirSync(path.join(projectDir, 'src'), { recursive: true })

  // Write a minimal package.json when bootstrapping a blank directory.
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) {
    const version = packageVersion()
    const packageManifest = useTsdown
      ? {
          name: packageName,
          ...(publishPrebuildPackage ? {} : { private: true }),
          ...(publishPrebuildPackage ? { version: '0.1.0' } : {}),
          ...(publishPrebuildPackage ? { publishConfig: { access: 'public' } } : {}),
          ...(packageManager?.source === 'installed'
            ? { packageManager: `${packageManager.name}@${packageManager.version}` }
            : {}),
          type: 'module',
          swiftNode: { shipSwiftRuntime },
          types: './dist/index.d.ts',
          exports: {
            '.': {
              import: {
                types: './dist/index.d.ts',
                default: './dist/index.js',
              },
              require: {
                types: './dist/index.d.cts',
                default: './dist/index.cjs',
              },
            },
          },
          main: './dist/index.cjs',
          scripts: {
            build: 'tsdown',
          },
          devDependencies: {
            'swift-node': `^${version}`,
            'swift-node-unplugin': `^${version}`,
            tsdown: '0.22.14',
            typescript: '^6.0.2',
          },
          files: packageFilesForPrebuildTargets(prebuildTargets, {
            bundleWithTsdown: true,
            shipSwiftRuntime,
          }),
        }
      : {
          name: packageName,
          ...(publishPrebuildPackage ? {} : { private: true }),
          ...(publishPrebuildPackage ? { version: '0.1.0' } : {}),
          ...(publishPrebuildPackage ? { publishConfig: { access: 'public' } } : {}),
          ...(packageManager?.source === 'installed'
            ? { packageManager: `${packageManager.name}@${packageManager.version}` }
            : {}),
          type: 'module',
          swiftNode: { shipSwiftRuntime },
          types: './dist_swift-node/index.d.ts',
          exports: {
            '.': {
              import: {
                types: './dist_swift-node/index.d.mts',
                default: './dist_swift-node/index.mjs',
              },
              require: {
                types: './dist_swift-node/index.d.cts',
                default: './dist_swift-node/index.cjs',
              },
            },
          },
          main: './dist_swift-node/index.cjs',
          scripts: {
            build: 'swift-node build',
          },
          devDependencies: {
            'swift-node': `^${version}`,
          },
          files: packageFilesForPrebuildTargets(prebuildTargets, { shipSwiftRuntime }),
        }
    writeFileSync(pkgPath, JSON.stringify(packageManifest, null, 2) + '\n')
    console.log(`Created ${pkgPath}`)

    if (packageManager?.source === 'corepack') {
      console.log(`Configuring Yarn ${packageManager.version} with Corepack...`)
      configureYarn(projectDir, packageManager.version)
    }
  }

  // Write template Swift file in the export-annotation style documented by the README.
  const swiftPath = path.join(projectDir, 'src', 'native.swift')
  if (!existsSync(swiftPath)) {
    writeFileSync(
      swiftPath,
      `// @swift-node:export
func helloWorld() -> String {
    "Hello, World!"
}
`,
    )
    console.log(`Created ${swiftPath}`)
  }

  const sourceEntryPath = path.join(projectDir, 'src', 'index.ts')
  if (!existsSync(sourceEntryPath)) {
    writeFileSync(sourceEntryPath, generateSourceEntryTs())
    console.log(`Created ${sourceEntryPath}`)
  }

  if (useTsdown) {
    const tsdownConfigPath = path.join(projectDir, 'tsdown.config.ts')
    if (existsSync(tsdownConfigPath)) {
      console.log(`Kept existing ${tsdownConfigPath}`)
    } else {
      writeFileSync(
        tsdownConfigPath,
        `import { defineConfig } from 'tsdown'
import swiftNodeNativeAssets from 'swift-node-unplugin/rolldown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  fixedExtension: false,
  dts: true,
  plugins: [swiftNodeNativeAssets()],
})
`,
      )
      console.log(`Created ${tsdownConfigPath}`)
    }
  }

  if (createPrebuildWorkflow) {
    const ciWorkflowPath = path.join(projectDir, '.github', 'workflows', 'ci.yml')
    if (existsSync(ciWorkflowPath)) {
      console.log(`Kept existing ${ciWorkflowPath}`)
    } else {
      mkdirSync(path.dirname(ciWorkflowPath), { recursive: true })
      writeFileSync(
        ciWorkflowPath,
        generatePrebuildCiWorkflow(prebuildTargets, {
          packageManager: packageManager?.name,
          packageManagerVersion: packageManager?.version,
        }),
      )
      console.log(`Created ${ciWorkflowPath}`)
    }

    const workflowPath = path.join(projectDir, '.github', 'workflows', 'publish.yml')
    if (existsSync(workflowPath)) {
      console.log(`Kept existing ${workflowPath}`)
    } else {
      mkdirSync(path.dirname(workflowPath), { recursive: true })
      writeFileSync(
        workflowPath,
        generatePrebuildWorkflow(prebuildTargets, {
          packageManager: packageManager?.name,
          packageManagerVersion: packageManager?.version,
          moduleName: readConfig(projectDir).moduleName,
          publishToNpm: publishPrebuildPackage,
          bundleWithTsdown: useTsdown,
          shipSwiftRuntime,
        }),
      )
      console.log(`Created ${workflowPath}`)
    }
  }

  // Ignore generated local output.
  const gitignorePath = path.join(projectDir, '.gitignore')
  const hasGitignore = existsSync(gitignorePath)
  const gitignore = hasGitignore ? readFileSync(gitignorePath, 'utf-8') : ''
  const gitignoreLines = new Set(gitignore.split(/\r?\n/))
  const template = gitignoreTemplate(
    packageManager?.name ?? existingProjectPackageManager,
    useTsdown,
  )
  const missingIgnores = template.entries.filter((entry) => !gitignoreLines.has(entry))
  if (missingIgnores.length > 0) {
    if (hasGitignore) {
      const prefix = gitignore.endsWith('\n') ? '' : '\n'
      writeFileSync(gitignorePath, gitignore + prefix + missingIgnores.join('\n') + '\n')
      console.log('Updated .gitignore')
    } else {
      writeFileSync(gitignorePath, template.content)
      console.log('Created .gitignore')
    }
  }

  if (buildNow) {
    console.log('\nInstalling dependencies and building the starter package...')
    runPackageManagerCommand(packageManager!, ['install'], projectDir)
    runPackageManagerCommand(packageManager!, ['run', 'build'], projectDir)
    return
  }

  const projectLabel = path.relative(cwd, projectDir) || '.'
  const packageManagerCommand =
    packageManager?.source === 'corepack' ? 'corepack yarn' : packageManager?.name
  const nextCommand = packageManagerCommand
    ? `${packageManagerCommand} install && ${packageManagerCommand} run build`
    : 'npm install && npm run build'
  if (projectLabel === '.') {
    console.log(`\nDone! Edit src/native.swift, then run: ${nextCommand}`)
  } else {
    console.log(
      `\nDone! Edit ${path.join(projectLabel, 'src', 'native.swift')}, then run: cd ${projectLabel} && ${nextCommand}`,
    )
  }
}

export interface BuildDependencies {
  compileSwift?: typeof compileSwift
  compileCpp?: typeof compileCpp
  link?: typeof link
  toolchainIdentity?: (cwd: string) => NativeBuildCacheConfiguration['toolchain']
  compileTargetIdentity?: (cwd: string) => NativeBuildCacheConfiguration['compileTarget']
}

function compilerExecutable(command: string): string {
  const pathEnvironment = process.env.PATH ?? process.env.Path ?? ''
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of pathEnvironment.split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`)
      if (!existsSync(candidate)) continue
      try {
        return realpathSync(candidate)
      } catch {
        return candidate
      }
    }
  }
  return command
}

function compilerIdentity(command: string): string {
  return fileIdentity(selectedCompilerExecutable(command))
}

function selectedCompilerExecutable(command: string): string {
  const pathSelected = compilerExecutable(command)
  if (process.platform !== 'darwin' || !pathSelected.startsWith('/usr/bin/')) return pathSelected

  if (process.platform === 'darwin') {
    try {
      const selected = execFileSync('xcrun', ['--find', command], { encoding: 'utf8' }).trim()
      if (selected) return realpathSync(selected)
    } catch {
      // xcrun is unavailable only on an incomplete macOS toolchain. The
      // launcher identity remains preferable to silently omitting it.
    }
  }
  return pathSelected
}

function fileIdentity(file: string): string {
  try {
    return `${realpathSync(file)}:${fileHash(file)}`
  } catch {
    return `${file}:unavailable`
  }
}

function currentToolchainIdentity(): NativeBuildCacheConfiguration['toolchain'] {
  return {
    swiftc: compilerIdentity('swiftc'),
    clang: compilerIdentity('clang++'),
  }
}

function nodeHeadersIdentity(): string {
  const includeDirectory = getNodeInclude()
  if (!includeDirectory) return 'unavailable'

  try {
    // These are the Node-API headers directly or transitively included by the
    // generated bridge. Hashing this small set keeps the cache-hit path cheap
    // while still noticing a replaced nodedir or changed Node API surface.
    const nodeApiHeaders = [
      'node_api.h',
      'node_api_types.h',
      'js_native_api.h',
      'js_native_api_types.h',
      'node_version.h',
    ]
    return [
      realpathSync(includeDirectory),
      ...nodeApiHeaders
        .map((header) => path.join(includeDirectory, header))
        .filter(existsSync)
        .map((header) => `${path.basename(header)}:${fileHash(header)}`),
    ].join('|')
  } catch {
    return `${includeDirectory}:unavailable`
  }
}

function selectedDeveloperDirectory(): string {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR
  if (process.platform !== 'darwin') return ''

  try {
    return execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unavailable'
  }
}

function nodeImportLibraryIdentity(): string {
  if (process.platform !== 'win32') return ''
  const importLibrary = getNodeImportLibrary()
  return importLibrary ? fileIdentity(importLibrary) : 'unavailable'
}

function currentCompileTarget(): NativeBuildCacheConfiguration['compileTarget'] {
  return {
    developerDir: selectedDeveloperDirectory(),
    nodeHeaders: nodeHeadersIdentity(),
    nodeImportLibrary: nodeImportLibraryIdentity(),
    sdkRoot: process.env.SDKROOT ?? '',
    toolchains: process.env.TOOLCHAINS ?? '',
    swiftFlags: process.env.SWIFTFLAGS ?? '',
    cFlags: process.env.CFLAGS ?? '',
    cxxFlags: process.env.CXXFLAGS ?? '',
    ldFlags: process.env.LDFLAGS ?? '',
  }
}

function generatorRuntimeIdentity(): NativeBuildCacheConfiguration['generatorRuntime'] {
  return {
    cli: fileIdentity(__filename),
    runtimeHeader: fileIdentity(path.resolve(__dirname, '..', 'runtime', 'swift-node-runtime.h')),
  }
}

function nativeBuildConfiguration(
  config: ReturnType<typeof readConfig>,
  toolchain: NativeBuildCacheConfiguration['toolchain'],
  compileTarget = currentCompileTarget(),
): NativeBuildCacheConfiguration {
  return {
    moduleName: config.moduleName,
    shipSwiftRuntime: config.shipSwiftRuntime,
    swiftNodeVersion: packageVersion(),
    platform: process.platform,
    arch: process.arch,
    nativeTarget: nativeTargetId(),
    minMacosVersion: config.minMacosVersion,
    nodeVersion: process.versions.node,
    nodeApiVersion: process.versions.napi ?? '',
    toolchain,
    generatorRuntime: generatorRuntimeIdentity(),
    compileTarget,
  }
}

function buildConfigurationFor(
  config: ReturnType<typeof readConfig>,
  cwd: string,
  dependencies: BuildDependencies,
): NativeBuildCacheConfiguration {
  return nativeBuildConfiguration(
    config,
    (dependencies.toolchainIdentity ?? (() => currentToolchainIdentity()))(cwd),
    (dependencies.compileTargetIdentity ?? (() => currentCompileTarget()))(cwd),
  )
}

function inputHashes(cwd: string, sources: readonly string[]): Record<string, string> {
  return Object.fromEntries(sources.map((source) => [source, fileHash(path.resolve(cwd, source))]))
}

function sameInputHashes(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

function runtimeSidecarFiles(generatedDir: string, nativeOutputDir: string): string[] {
  if (nativeOutputDir === generatedDir || !existsSync(nativeOutputDir)) return []
  return readdirSync(nativeOutputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isRuntimeSidecar(entry.name))
    .map((entry) => path.relative(generatedDir, path.join(nativeOutputDir, entry.name)))
    .sort()
}

function isRuntimeSidecar(filename: string): boolean {
  return filename.toLowerCase().endsWith('.dll') || /\.so(?:\..+)?$/i.test(filename)
}

function removeNativeArtifacts(nativeOutputDir: string, nativeTarget: string): void {
  if (!existsSync(nativeOutputDir)) return
  for (const entry of readdirSync(nativeOutputDir, { withFileTypes: true })) {
    const isCurrentTargetBinary =
      process.platform === 'darwin'
        ? entry.name.endsWith(`.${nativeTarget}.node`)
        : entry.name.endsWith('.node')
    if (isCurrentTargetBinary || isRuntimeSidecar(entry.name)) {
      rmSync(path.join(nativeOutputDir, entry.name), { force: true, recursive: true })
    }
  }
}

function removeGeneratedRuntimeFiles(generatedDir: string): void {
  for (const output of generatedRuntimeFiles) {
    rmSync(path.join(generatedDir, output), { force: true, recursive: true })
  }
}

function ensureGeneratedDirectory(directory: string): void {
  try {
    const stats = lstatSync(directory)
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      rmSync(directory, { force: true, recursive: true })
    }
  } catch {
    // The directory does not exist yet, or became unavailable while checking.
  }
  mkdirSync(directory, { recursive: true })
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function nativeBuildLockOwnerIsAlive(lockDirectory: string): boolean | null {
  try {
    const owner = JSON.parse(readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8')) as {
      pid?: unknown
    }
    if (!Number.isSafeInteger(owner.pid) || typeof owner.pid !== 'number' || owner.pid <= 0) {
      return null
    }
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : true
    }
  } catch {
    return null
  }
}

function nativeBuildLockIsStale(
  lockDirectory: string,
  ownerlessSince?: number,
  observedMtime?: number,
): boolean {
  const stats = lstatSync(lockDirectory)
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Native build lock at ${lockDirectory} is not a directory.`)
  }
  const age = Date.now() - (observedMtime ?? stats.mtimeMs)
  const ownerIsAlive = nativeBuildLockOwnerIsAlive(lockDirectory)
  if (ownerIsAlive === null) {
    return Date.now() - (ownerlessSince ?? stats.mtimeMs) > ownerlessNativeBuildLockGraceMs
  }
  // PIDs can eventually be reused. An active native build should never span
  // this generous bound, so an ancient lock is safer to reclaim than trust.
  return ownerIsAlive === false || age > staleNativeBuildLockMs
}

/**
 * Claims stale-lock recovery inside the candidate lock before removing it.
 * A later waiter therefore rechecks the new owner instead of deleting a lock
 * another process acquired between its first stale observation and cleanup.
 */
function reclaimStaleNativeBuildLock(
  lockDirectory: string,
  ownerlessSince: number,
  observedMtime: number,
): void {
  const reaper = path.join(lockDirectory, '.reaping')
  let descriptor: number | undefined
  try {
    descriptor = openSync(reaper, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    try {
      if (Date.now() - lstatSync(reaper).mtimeMs > staleNativeBuildReaperMs) {
        rmSync(reaper, { force: true })
      }
    } catch {
      // The reaper or its lock disappeared; the next acquisition retry will
      // determine the current state.
    }
    return
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  try {
    if (nativeBuildLockIsStale(lockDirectory, ownerlessSince, observedMtime)) {
      rmSync(lockDirectory, { force: true, recursive: true })
      return
    }
  } finally {
    // If the directory still belongs to a live build, leave it exactly as it
    // was. If it was removed, this is naturally a no-op.
    rmSync(reaper, { force: true })
  }
}

/**
 * Serializes native output replacement between separate swift-node processes.
 * The unplugin deduplicates within one bundler process; this lock makes the
 * manifest and its output hashes equally reliable for separate CLI processes.
 */
function acquireNativeBuildLock(projectDir: string): () => void {
  const lockDirectory = path.join(projectDir, nativeBuildLockDirectoryName)
  const owner = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
  const deadline = Date.now() + nativeBuildLockTimeoutMs

  while (true) {
    try {
      mkdirSync(lockDirectory)
      try {
        writeFileSync(path.join(lockDirectory, 'owner.json'), owner)
      } catch (error) {
        rmSync(lockDirectory, { force: true, recursive: true })
        throw error
      }
      return () => {
        try {
          if (readFileSync(path.join(lockDirectory, 'owner.json'), 'utf8') === owner) {
            rmSync(lockDirectory, { force: true, recursive: true })
          }
        } catch {
          // A replacement owner must never be removed by this process.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    try {
      const observedMtime = lstatSync(lockDirectory).mtimeMs
      if (nativeBuildLockIsStale(lockDirectory, observedMtime)) {
        reclaimStaleNativeBuildLock(lockDirectory, observedMtime, observedMtime)
        continue
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('Native build lock')) throw error
      // The lock disappeared while inspecting it. Retry acquisition immediately.
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for another swift-node build in ${projectDir}.`)
    }
    pause(25)
  }
}

export function cmdBuild(cwd = process.cwd(), dependencies: BuildDependencies = {}) {
  if (!isSupportedPlatform()) {
    throw new Error(
      `swift-node build supports macOS, Linux, and Windows; received ${process.platform}.`,
    )
  }
  const releaseNativeBuildLock = acquireNativeBuildLock(cwd)
  try {
    let config = readConfig(cwd)

    const generatedDir = path.join(cwd, generatedDirName)
    const nativeTarget = nativeTargetId()
    const nativeOutputDir =
      process.platform === 'darwin' ? generatedDir : path.join(generatedDir, nativeTarget)
    let binaryName = prebuildFilename(config.moduleName)
    let expectedOutputs = [
      ...generatedRuntimeFiles,
      path.relative(generatedDir, path.join(nativeOutputDir, binaryName)),
    ]
    let inputs: Record<string, string>
    inputs = inputHashes(cwd, config.swiftSources)
    let buildConfiguration: NativeBuildCacheConfiguration | undefined

    // On a first build, generating the ESM/CJS runtime must happen immediately:
    // tsdown starts declaration generation concurrently with this plugin. An
    // existing manifest, however, is only trusted after re-identifying the
    // active toolchain.
    if (readNativeBuildManifest(generatedDir)) {
      buildConfiguration = buildConfigurationFor(config, cwd, dependencies)
      if (isNativeBuildUpToDate(generatedDir, inputs, buildConfiguration, expectedOutputs)) {
        // Re-read the package-derived source list and configuration immediately
        // before returning. An editor can add a new src/*.swift file (or alter
        // package.json) while validation is in progress; cache hits must not
        // claim a binary is current for that newer project state.
        const recheckedConfig = readConfig(cwd)
        const recheckedInputs = inputHashes(cwd, recheckedConfig.swiftSources)
        const recheckedBinaryName = prebuildFilename(recheckedConfig.moduleName)
        const recheckedOutputs = [
          ...generatedRuntimeFiles,
          path.relative(generatedDir, path.join(nativeOutputDir, recheckedBinaryName)),
        ]
        const recheckedConfiguration = buildConfigurationFor(recheckedConfig, cwd, dependencies)
        if (
          isNativeBuildUpToDate(
            generatedDir,
            recheckedInputs,
            recheckedConfiguration,
            recheckedOutputs,
          )
        ) {
          console.log(`Native addon is up to date: ${recheckedConfig.moduleName}`)
          return
        }
        config = recheckedConfig
        inputs = recheckedInputs
        binaryName = recheckedBinaryName
        expectedOutputs = recheckedOutputs
        buildConfiguration = recheckedConfiguration
      }
    }

    console.log(`Building ${config.moduleName}...`)

    // 1. Parse Swift sources
    let allFunctions: SwiftFunction[] = []
    let allStructs: SwiftStruct[] = []
    let allCodableTypes: SwiftCodableType[] = []
    let allExported: ReturnType<typeof parseExportedFunctions> = []
    const allSources: Map<string, string> = new Map()

    for (const src of config.swiftSources) {
      const fullPath = path.resolve(cwd, src)
      if (!existsSync(fullPath)) {
        throw new Error(`Swift source not found: ${src}`)
      }
      const source = readFileSync(fullPath, 'utf-8')
      allSources.set(src, source)
      const structs = parseSwiftStructs(source)
      const codableTypes = parseSwiftCodableTypes(source)
      allStructs.push(...structs)
      allCodableTypes.push(...codableTypes)
    }

    const globalActorNames = new Set<string>()
    for (const source of allSources.values()) {
      for (const name of parseSwiftGlobalActorNames(source)) globalActorNames.add(name)
    }
    for (const source of allSources.values()) {
      allExported.push(...parseExportedFunctions(source, globalActorNames))
    }

    // Validate export annotations
    if (allExported.length > 0) {
      let hasErrors = false
      for (const [src, source] of allSources) {
        const exported = parseExportedFunctions(source, globalActorNames)
        if (exported.length === 0) continue
        const errors = validateExports(exported, source, allStructs, allCodableTypes)
        for (const err of errors) {
          console.error(
            `${err.severity === 'error' ? 'Error' : 'Warning'}: ${src}:${err.line}: ${err.message}`,
          )
          if (err.severity === 'error') hasErrors = true
        }
      }
      if (hasErrors) {
        throw new Error('Swift export validation failed.')
      }
    }

    // Convert exported functions to SwiftFunction[] for the C++ generator
    const codableNames = allCodableTypes.map((type) => type.name)
    allFunctions = exportedToSwiftFunctions(
      allExported,
      config.moduleName,
      allStructs,
      codableNames,
    )

    if (allFunctions.length === 0) {
      throw new Error(
        'No exported functions found in Swift sources. Add // @swift-node:export above a Swift function.',
      )
    }

    // Filter structs to only those referenced by exported functions
    // Functions may reference structs by Swift name (Point) or C name (swift_node_Point)
    const referencedTypes = new Set<string>()
    for (const fn of allFunctions) {
      for (const p of fn.params) {
        referencedTypes.add(p.type)
      }
      referencedTypes.add(fn.returnType)
    }
    allStructs = allStructs.filter(
      (s) => referencedTypes.has(s.name) || referencedTypes.has(`swift_node_${s.name}`),
    )

    if (allExported.length > 0) {
      console.log(
        `  Found ${allExported.length} export-annotated function(s), generating wrappers...`,
      )
    }
    if (allStructs.length > 0) {
      console.log(
        `  Found ${allStructs.length} struct(s): ${allStructs.map((s) => s.name).join(', ')}`,
      )
    }

    // 2. Generate persistent runtime files in dist_swift-node/ and compilation-only files
    // in a temporary directory. A project therefore never accumulates bridge
    // sources or object files between builds.
    // macOS has no bundled Swift runtime sidecars, so its target-qualified
    // binaries can live directly beside the generated runtime. Linux and
    // Windows keep a target directory because their Swift runtime libraries
    // must be loaded from the same directory as the addon.
    const scratchDir = mkdtempSync(path.join(tmpdir(), 'swift-node-build-'))
    ensureGeneratedDirectory(generatedDir)
    if (nativeOutputDir !== generatedDir) ensureGeneratedDirectory(nativeOutputDir)

    try {
      const runtimeDir = path.resolve(__dirname, '..', 'runtime')

      // A failed replacement must not leave a previous build looking valid
      // after this invocation has regenerated any output files. This happens
      // only after the generated directory itself has been made safe, so a
      // replaced output-directory symlink cannot redirect the deletion.
      rmSync(path.join(generatedDir, nativeBuildManifestFilename), { force: true })

      // Rebuilds own these exact generated files. Removing them first avoids
      // following a replaced symlink and removes stale declarations/loaders.
      removeGeneratedRuntimeFiles(generatedDir)

      // Keep the runtime API available before preparing compiler-only bridge
      // sources. tsdown can begin its declaration pass concurrently with the
      // unplugin's native build hook, and this entry point is all it needs to
      // resolve the generated module.
      writeFileSync(
        path.join(generatedDir, 'index.d.ts'),
        generateDts(allFunctions, config.moduleName, allStructs),
      )
      writeFileSync(
        path.join(generatedDir, 'index.d.cts'),
        generateDtsCjs(allFunctions, config.moduleName, allStructs),
      )
      writeFileSync(
        path.join(generatedDir, 'index.mjs'),
        generateEntryMjs(allFunctions, config.moduleName),
      )
      writeFileSync(
        path.join(generatedDir, 'index.cjs'),
        generateEntryCjs(allFunctions, config.moduleName),
      )
      // TypeScript resolves types for .mjs via .d.mts.
      copyFileSync(path.join(generatedDir, 'index.d.ts'), path.join(generatedDir, 'index.d.mts'))
      console.log('  Generated dist_swift-node runtime files')

      // Generate Swift wrappers for export-annotated functions.
      let wrappersSwiftPath: string | null = null
      if (allExported.length > 0) {
        const wrappersCode = generateWrappersSwift(
          allExported,
          config.moduleName,
          allStructs,
          codableNames,
        )
        wrappersSwiftPath = path.join(scratchDir, 'wrappers.swift')
        writeFileSync(wrappersSwiftPath, wrappersCode)
      }

      // Generate the bridge sources used only by this invocation.
      if (allStructs.length > 0) {
        writeFileSync(
          path.join(scratchDir, 'swift_node_structs.h'),
          generateStructsHeader(allStructs),
        )
      }
      writeFileSync(
        path.join(scratchDir, 'addon.cpp'),
        generateAddonCpp(allFunctions, config.moduleName, allStructs),
      )
      writeFileSync(
        path.join(scratchDir, 'bridge.h'),
        generateBridgeH(allFunctions, config.moduleName, allStructs),
      )

      buildConfiguration ??= buildConfigurationFor(config, cwd, dependencies)

      // Native binaries and runtime sidecars are compiler output. Clear prior
      // target artifacts before linking so a renamed module, changed toolchain,
      // or changed shipSwiftRuntime cannot retain and re-bundle stale files.
      removeNativeArtifacts(nativeOutputDir, nativeTarget)

      // 3. Compile & link. Object files belong with the temporary bridge code.
      // Preserve source paths passed to swiftc: constructs such as #file and
      // diagnostics are part of a Swift module's observable behavior. If an
      // editor changes an input during compilation, the post-link hash check
      // below simply declines to publish a cache manifest for that build.
      const swiftSources = [...config.swiftSources]
      if (wrappersSwiftPath) swiftSources.push(wrappersSwiftPath)

      const compilerConfig = {
        moduleName: config.moduleName,
        binaryName,
        swiftSources,
        projectDir: cwd,
        intermediateDir: scratchDir,
        buildDir: nativeOutputDir,
        objDir: scratchDir,
        runtimeDir,
        minMacosVersion: config.minMacosVersion,
        shipSwiftRuntime: config.shipSwiftRuntime,
      }

      console.log('  Compiling Swift...')
      const swiftObj = (dependencies.compileSwift ?? compileSwift)(compilerConfig)

      console.log('  Compiling C++...')
      const cppObj = (dependencies.compileCpp ?? compileCpp)(compilerConfig)

      console.log('  Linking...')
      const nodeFile = (dependencies.link ?? link)(compilerConfig, [swiftObj, cppObj])

      // Header/import-library discovery can download prerequisites during the
      // first C++ build on Windows. Re-identify after linking so the first
      // manifest describes the toolchain that actually produced the binary.
      const completedBuildConfiguration = buildConfigurationFor(config, cwd, dependencies)
      const completedInputs = inputHashes(cwd, config.swiftSources)
      if (sameInputHashes(inputs, completedInputs)) {
        writeNativeBuildManifest(generatedDir, completedInputs, completedBuildConfiguration, [
          ...expectedOutputs,
          ...(config.shipSwiftRuntime ? runtimeSidecarFiles(generatedDir, nativeOutputDir) : []),
        ])
      } else {
        console.log('  Native sources changed during compilation; skipping build manifest.')
      }

      console.log(`\n  ✓ Built: ${path.relative(cwd, nodeFile)}`)
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  } finally {
    releaseNativeBuildLock()
  }
}

function cmdDoctor() {
  let ok = true

  if (isSupportedPlatform()) {
    console.log(`✓ platform: ${process.platform}`)
  } else {
    console.log(`✗ platform: ${process.platform} (swift-node supports macOS, Linux, and Windows)`)
    ok = false
  }

  // Check swiftc
  try {
    const ver = execSync('swiftc --version', { encoding: 'utf-8' }).trim().split('\n')[0]
    console.log(`✓ swiftc: ${ver}`)
  } catch {
    console.log('✗ swiftc: not found')
    ok = false
  }

  // Check clang++
  try {
    const ver = execSync('clang++ --version', { encoding: 'utf-8' }).trim().split('\n')[0]
    console.log(`✓ clang++: ${ver}`)
  } catch {
    console.log('✗ clang++: not found')
    ok = false
  }

  // Xcode is only a macOS prerequisite. Linux and Windows Swift toolchains
  // provide clang++ without Xcode.
  if (process.platform === 'darwin') {
    try {
      const p = execSync('xcode-select -p', { encoding: 'utf-8' }).trim()
      console.log(`✓ Xcode: ${p}`)
    } catch {
      console.log('✗ Xcode: not found (install Xcode or Command Line Tools)')
      ok = false
    }
  }

  // Check Node headers. On Windows, build downloads them into swift-node's
  // node-gyp cache when the Node distribution does not bundle an include/ tree.
  const nodeInclude = getNodeInclude()
  if (nodeInclude) {
    console.log(`✓ Node-API headers: ${nodeInclude}`)
  } else {
    console.log('✗ Node-API headers: not installed (swift-node build will download them)')
    ok = false
  }

  console.log('')
  console.log(ok ? 'All checks passed.' : 'Some checks failed. Fix the issues above.')
  process.exit(ok ? 0 : 1)
}
