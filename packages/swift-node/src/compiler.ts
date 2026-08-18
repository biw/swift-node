/**
 * Invokes swiftc and clang++ to compile and link a .node binary.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export interface CompilerConfig {
  moduleName: string
  /** Exact filename accepted by the generated runtime resolver. */
  binaryName: string
  swiftSources: string[]
  projectDir: string
  intermediateDir: string
  buildDir: string // final output (.node binary)
  objDir: string // intermediate object files (.o)
  runtimeDir: string
  minMacosVersion: string
  /** Copy the Swift dynamic runtime beside Linux and Windows binaries. */
  shipSwiftRuntime: boolean
}

export type SupportedPlatform = 'darwin' | 'linux' | 'win32'

export function isSupportedPlatform(platform = process.platform): platform is SupportedPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg
}

function run(cmd: string, args: string[], cwd: string): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch (e: any) {
    const stderr = e.stderr?.toString() || ''
    const stdout = e.stdout?.toString() || ''
    throw new Error(
      `Command failed: ${[cmd, ...args].map(quoteArg).join(' ')}\n${stderr}\n${stdout}`,
    )
  }
}

export interface NodeHeaderOptions {
  platform?: NodeJS.Platform
  execPath?: string
  nodeVersion?: string
  arch?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  fileExists?: (file: string) => boolean
}

export interface SwiftRuntimeCopyOptions {
  platform?: NodeJS.Platform
  cwd?: string
  targetInfo?: string
  readDirectory?: (directory: string) => string[]
  copyFile?: (source: string, destination: string) => void
  makeDirectory?: (directory: string) => void
}

function pathsFor(platform: NodeJS.Platform): typeof path {
  return platform === 'win32' ? path.win32 : path.posix
}

export function nodeGypDevDir(platform = process.platform, homeDir = homedir()): string {
  return pathsFor(platform).join(homeDir, '.swift-node', 'node-gyp')
}

function nodeIncludeCandidates({
  platform = process.platform,
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  homeDir = homedir(),
  env = process.env,
}: NodeHeaderOptions = {}): string[] {
  const paths = pathsFor(platform)
  const executableDir = paths.dirname(execPath)
  const bundledHeaders =
    platform === 'win32'
      ? paths.join(executableDir, 'include', 'node')
      : paths.resolve(executableDir, '..', 'include', 'node')
  const configuredHeaders = env.npm_config_nodedir
    ? paths.join(env.npm_config_nodedir, 'include', 'node')
    : null
  const nodeGypHeaders = paths.join(
    nodeGypDevDir(platform, homeDir),
    nodeVersion,
    'include',
    'node',
  )

  return [configuredHeaders, bundledHeaders, nodeGypHeaders].filter(
    (candidate): candidate is string => candidate !== null,
  )
}

/** Find installed Node-API headers without assuming that Node's Windows zip contains them. */
export function getNodeInclude(options: NodeHeaderOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const paths = pathsFor(platform)
  const fileExists = options.fileExists ?? existsSync
  return (
    nodeIncludeCandidates(options).find((candidate) =>
      fileExists(paths.join(candidate, 'node_api.h')),
    ) ?? null
  )
}

function nodeImportLibraryCandidates({
  platform = process.platform,
  execPath = process.execPath,
  nodeVersion = process.versions.node,
  arch = process.arch,
  homeDir = homedir(),
}: NodeHeaderOptions = {}): string[] {
  if (platform !== 'win32') return []

  const paths = pathsFor(platform)
  return [
    paths.join(paths.dirname(execPath), 'node.lib'),
    paths.join(nodeGypDevDir(platform, homeDir), nodeVersion, arch, 'node.lib'),
  ]
}

/** True when node-gyp must provide headers or Windows' Node import library. */
export function needsNodeGypInstall(options: NodeHeaderOptions = {}): boolean {
  const platform = options.platform ?? process.platform
  if (!getNodeInclude(options)) return true
  if (platform !== 'win32') return false

  const fileExists = options.fileExists ?? existsSync
  return !nodeImportLibraryCandidates(options).some(fileExists)
}

function ensureNodeDevelopmentFiles(): string {
  if (!needsNodeGypInstall()) return getNodeInclude()!

  const devDir = nodeGypDevDir()
  const nodeGypCli = require.resolve('node-gyp/bin/node-gyp.js')
  run(
    process.execPath,
    [nodeGypCli, 'install', `--target=${process.versions.node}`, '--devdir', devDir],
    process.cwd(),
  )

  const downloadedInclude = getNodeInclude()
  if (!downloadedInclude) {
    throw new Error(`Node-API headers were not installed in ${devDir}.`)
  }
  if (process.platform === 'win32' && !getNodeImportLibrary()) {
    throw new Error(`Node import library was not installed in ${devDir}.`)
  }
  return downloadedInclude
}

export function getNodeImportLibrary(options: NodeHeaderOptions = {}): string | null {
  const fileExists = options.fileExists ?? existsSync
  return nodeImportLibraryCandidates(options).find(fileExists) ?? null
}

/** Use one explicit target for every Swift and C++ compilation/link step. */
export function macosDeploymentTarget(minimumVersion: string, _arch = process.arch): string {
  return minimumVersion
}

function swiftRuntimeLibraryPaths(targetInfo: string): string[] {
  try {
    const parsed = JSON.parse(targetInfo) as { paths?: { runtimeLibraryPaths?: unknown } }
    const runtimeLibraryPaths = parsed.paths?.runtimeLibraryPaths
    return Array.isArray(runtimeLibraryPaths)
      ? runtimeLibraryPaths.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * Copy the dynamically linked Swift runtime beside a native binary. Node loads
 * addons as dynamic libraries, so Linux and Windows resolve these sidecars from
 * the addon's own directory rather than requiring a system Swift installation.
 */
export function copySwiftRuntimeLibraries(
  outputDirectory: string,
  options: SwiftRuntimeCopyOptions = {},
): string[] {
  const platform = options.platform ?? process.platform
  if (platform !== 'linux' && platform !== 'win32') return []

  const targetInfo =
    options.targetInfo ?? run('swiftc', ['-print-target-info'], options.cwd ?? process.cwd())
  const runtimeDirectories = swiftRuntimeLibraryPaths(targetInfo)
  const paths = pathsFor(platform)
  const readDirectory = options.readDirectory ?? ((directory) => readdirSync(directory))
  const copyFile = options.copyFile ?? copyFileSync
  const makeDirectory =
    options.makeDirectory ?? ((directory) => mkdirSync(directory, { recursive: true }))
  const copied = new Set<string>()

  makeDirectory(outputDirectory)
  for (const directory of runtimeDirectories) {
    let entries: string[]
    try {
      entries = readDirectory(directory)
    } catch {
      continue
    }

    for (const entry of entries) {
      const isRuntimeLibrary =
        platform === 'win32' ? entry.toLowerCase().endsWith('.dll') : /\.so(?:\..+)?$/i.test(entry)
      if (!isRuntimeLibrary || copied.has(entry.toLowerCase())) continue
      copyFile(paths.join(directory, entry), paths.join(outputDirectory, entry))
      copied.add(entry.toLowerCase())
    }
  }

  if (copied.size === 0) {
    throw new Error(
      `Swift runtime libraries were not found in swiftc runtimeLibraryPaths for ${platform}.`,
    )
  }
  return [...copied]
}

// Swift module names must be valid identifiers (no hyphens, no leading digits)
function sanitizeModuleName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&')
}

export function swiftCompileArgs(
  config: CompilerConfig,
  platform = process.platform,
  arch = process.arch,
): string[] {
  const outputFile = path.join(config.objDir, 'swift.o')
  const swiftModuleName = sanitizeModuleName(config.moduleName)

  const sources = config.swiftSources.map((source) => path.resolve(config.projectDir, source))

  // Import generated C struct definitions if they exist
  const structsHeader = path.join(config.intermediateDir, 'swift_node_structs.h')
  const importHeader = existsSync(structsHeader) ? ['-import-objc-header', structsHeader] : []

  const macosTarget = macosDeploymentTarget(config.minMacosVersion, arch)
  const args = [
    '-emit-object',
    '-O',
    '-whole-module-optimization',
    '-module-name',
    swiftModuleName,
    '-parse-as-library',
    ...(platform === 'darwin'
      ? ['-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx${macosTarget}`]
      : []),
    ...(platform === 'linux' ? ['-Xcc', '-fPIC'] : []),
    ...importHeader,
    ...sources,
    '-o',
    outputFile,
  ]

  return args
}

/**
 * Invoke the macOS compiler through xcrun so it receives an Xcode SDK.
 * Preserve an explicit SDKROOT; otherwise select the default macOS SDK.
 * xcrun also honors TOOLCHAINS, which lets callers use a Swift toolchain
 * installed alongside Xcode without losing access to Apple frameworks.
 */
export function swiftcInvocation(
  args: string[],
  platform = process.platform,
  sdkRoot = process.env.SDKROOT,
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return {
      command: 'xcrun',
      args: [...(sdkRoot ? [] : ['--sdk', 'macosx']), 'swiftc', ...args],
    }
  }
  return { command: 'swiftc', args }
}

export function compileSwift(config: CompilerConfig): string {
  const outputFile = path.join(config.objDir, 'swift.o')
  const { command, args } = swiftcInvocation(swiftCompileArgs(config))
  run(command, args, config.projectDir)
  return outputFile
}

export function cppCompileArgs(
  config: CompilerConfig,
  platform = process.platform,
  nodeInclude = getNodeInclude() ?? nodeIncludeCandidates()[0],
  arch = process.arch,
): string[] {
  const addonCpp = path.join(config.intermediateDir, 'addon.cpp')

  return [
    '-c',
    '-std=c++17',
    ...(platform === 'win32' ? [] : ['-fPIC']),
    ...(platform === 'darwin'
      ? [`-mmacosx-version-min=${macosDeploymentTarget(config.minMacosVersion, arch)}`]
      : []),
    // Swift's Windows runtime uses the dynamic MSVC CRT. Match it so lld does
    // not reject addon.o with an MT/MD RuntimeLibrary mismatch at link time.
    ...(platform === 'win32' ? ['-fms-runtime-lib=dll'] : []),
    `-I${nodeInclude}`,
    `-I${config.intermediateDir}`,
    `-I${config.runtimeDir}`,
    '-DNAPI_VERSION=8',
    `-DNODE_GYP_MODULE_NAME=${sanitizeModuleName(config.moduleName)}`,
    addonCpp,
    '-o',
    path.join(config.objDir, 'addon.o'),
  ]
}

export function compileCpp(config: CompilerConfig): string {
  const outputFile = path.join(config.objDir, 'addon.o')
  run(
    'clang++',
    cppCompileArgs(config, process.platform, ensureNodeDevelopmentFiles()),
    config.projectDir,
  )
  return outputFile
}

export function linkCommand(
  config: CompilerConfig,
  objectFiles: string[],
  platform = process.platform,
  _arch = process.arch,
): { command: string; args: string[] } {
  const outputFile = pathsFor(platform).join(config.buildDir, config.binaryName)

  if (platform === 'darwin') {
    const targetArch = _arch === 'x64' ? 'x86_64' : _arch
    return {
      command: 'clang++',
      args: [
        '-shared',
        '-undefined',
        'dynamic_lookup',
        '-target',
        `${targetArch}-apple-macosx${macosDeploymentTarget(config.minMacosVersion, _arch)}`,
        '-o',
        outputFile,
        ...objectFiles,
      ],
    }
  }

  if (platform === 'linux') {
    return {
      command: 'swiftc',
      args: [
        '-emit-library',
        '-Xlinker',
        '--unresolved-symbols=ignore-all',
        // Resolve the Swift runtime that build() places beside this .node file.
        '-Xlinker',
        '-rpath',
        '-Xlinker',
        '$ORIGIN',
        '-o',
        outputFile,
        ...objectFiles,
      ],
    }
  }

  if (platform !== 'win32') {
    throw new Error(
      `Unsupported platform '${platform}'. swift-node supports macOS, Linux, and Windows.`,
    )
  }

  const nodeImportLibrary =
    getNodeImportLibrary({ platform }) ?? nodeImportLibraryCandidates({ platform })[0]
  return {
    command: 'swiftc',
    args: ['-emit-library', '-o', outputFile, ...objectFiles, nodeImportLibrary!],
  }
}

export function link(config: CompilerConfig, objectFiles: string[]): string {
  const outputFile = path.join(config.buildDir, config.binaryName)
  const { command, args } = linkCommand(config, objectFiles)
  if (process.platform === 'win32') {
    const nodeImportLibrary = getNodeImportLibrary()
    if (!nodeImportLibrary || !existsSync(nodeImportLibrary)) {
      throw new Error(
        `Node import library not found at ${nodeImportLibrary ?? '(unavailable)'}. Install a Windows Node.js distribution that includes node.lib.`,
      )
    }
  }
  run(command, args, config.projectDir)
  if (config.shipSwiftRuntime && (process.platform === 'linux' || process.platform === 'win32')) {
    copySwiftRuntimeLibraries(config.buildDir, { cwd: config.projectDir })
  }
  return outputFile
}
