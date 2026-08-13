import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const nativeBuildManifestFilename = '.swift-node-build.json'
const manifestSchemaVersion = 1

export interface NativeBuildCacheConfiguration {
  moduleName: string
  shipSwiftRuntime: boolean
  swiftNodeVersion: string
  platform: NodeJS.Platform
  arch: string
  nativeTarget: string
  minMacosVersion: string
  nodeVersion: string
  nodeApiVersion: string
  toolchain: {
    swiftc: string
    clang: string
  }
  generatorRuntime: {
    cli: string
    runtimeHeader: string
  }
  compileTarget: {
    developerDir: string
    nodeHeaders: string
    sdkRoot: string
    toolchains: string
    swiftFlags: string
    cFlags: string
    cxxFlags: string
    ldFlags: string
  }
}

export interface NativeBuildManifest {
  schemaVersion: number
  inputs: Record<string, string>
  configuration: NativeBuildCacheConfiguration
  outputs: Record<string, string>
}

export function fileHash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

function isHashMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(([key, hash]) => key.length > 0 && isHash(hash))
  )
}

function isToolchain(value: unknown): value is NativeBuildCacheConfiguration['toolchain'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { swiftc?: unknown }).swiftc === 'string' &&
    typeof (value as { clang?: unknown }).clang === 'string'
  )
}

function isGeneratorRuntime(
  value: unknown,
): value is NativeBuildCacheConfiguration['generatorRuntime'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { cli?: unknown }).cli === 'string' &&
    typeof (value as { runtimeHeader?: unknown }).runtimeHeader === 'string'
  )
}

function isCompileTarget(
  value: unknown,
): value is NativeBuildCacheConfiguration['compileTarget'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { developerDir?: unknown }).developerDir === 'string' &&
    typeof (value as { nodeHeaders?: unknown }).nodeHeaders === 'string' &&
    typeof (value as { sdkRoot?: unknown }).sdkRoot === 'string' &&
    typeof (value as { toolchains?: unknown }).toolchains === 'string' &&
    typeof (value as { swiftFlags?: unknown }).swiftFlags === 'string' &&
    typeof (value as { cFlags?: unknown }).cFlags === 'string' &&
    typeof (value as { cxxFlags?: unknown }).cxxFlags === 'string' &&
    typeof (value as { ldFlags?: unknown }).ldFlags === 'string'
  )
}

function isConfiguration(value: unknown): value is NativeBuildCacheConfiguration {
  if (typeof value !== 'object' || value === null) return false
  const config = value as Partial<NativeBuildCacheConfiguration>
  return (
    typeof config.moduleName === 'string' &&
    typeof config.shipSwiftRuntime === 'boolean' &&
    typeof config.swiftNodeVersion === 'string' &&
    typeof config.platform === 'string' &&
    typeof config.arch === 'string' &&
    typeof config.nativeTarget === 'string' &&
    typeof config.minMacosVersion === 'string' &&
    typeof config.nodeVersion === 'string' &&
    typeof config.nodeApiVersion === 'string' &&
    isToolchain(config.toolchain) &&
    isGeneratorRuntime(config.generatorRuntime) &&
    isCompileTarget(config.compileTarget)
  )
}

export function manifestPath(generatedDirectory: string): string {
  return path.join(generatedDirectory, nativeBuildManifestFilename)
}

export function readNativeBuildManifest(generatedDirectory: string): NativeBuildManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(generatedDirectory), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    const manifest = parsed as Partial<NativeBuildManifest>
    if (
      manifest.schemaVersion !== manifestSchemaVersion ||
      !isHashMap(manifest.inputs) ||
      !isConfiguration(manifest.configuration) ||
      !isHashMap(manifest.outputs)
    ) {
      return null
    }
    return manifest as NativeBuildManifest
  } catch {
    return null
  }
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  )
}

function sameConfiguration(
  left: NativeBuildCacheConfiguration,
  right: NativeBuildCacheConfiguration,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * A cache entry is valid only when every input, native-build setting, and
 * generated runtime/native output has its exact recorded content hash.
 */
export function isNativeBuildUpToDate(
  generatedDirectory: string,
  inputs: Record<string, string>,
  configuration: NativeBuildCacheConfiguration,
  requiredOutputs: readonly string[],
): boolean {
  const manifest = readNativeBuildManifest(generatedDirectory)
  if (!manifest) return false
  try {
    const generatedDirectoryStats = lstatSync(generatedDirectory)
    if (!generatedDirectoryStats.isDirectory() || generatedDirectoryStats.isSymbolicLink()) return false
  } catch {
    return false
  }
  if (!sameRecord(manifest.inputs, inputs) || !sameConfiguration(manifest.configuration, configuration)) {
    return false
  }
  if (!requiredOutputs.every((output) => Object.hasOwn(manifest.outputs, output))) return false

  return Object.entries(manifest.outputs).every(([relativePath, hash]) => {
    const output = path.resolve(generatedDirectory, relativePath)
    const relative = path.relative(generatedDirectory, output)
    try {
      if (
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        !existsSync(output) ||
        !lstatSync(output).isFile()
      ) {
        return false
      }
      return fileHash(output) === hash
    } catch {
      return false
    }
  })
}

export function writeNativeBuildManifest(
  generatedDirectory: string,
  inputs: Record<string, string>,
  configuration: NativeBuildCacheConfiguration,
  outputPaths: readonly string[],
): void {
  const outputs: Record<string, string> = {}
  for (const relativePath of [...outputPaths].sort()) {
    const output = path.resolve(generatedDirectory, relativePath)
    if (!existsSync(output) || !lstatSync(output).isFile()) {
      throw new Error(`Cannot write native build manifest because ${relativePath} is missing.`)
    }
    outputs[relativePath] = fileHash(output)
  }

  const manifest: NativeBuildManifest = {
    schemaVersion: manifestSchemaVersion,
    inputs,
    configuration,
    outputs,
  }
  const destination = manifestPath(generatedDirectory)
  const temporary = `${destination}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n')
  renameSync(temporary, destination)
}
