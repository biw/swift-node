import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export const generatedDirectoryName = 'dist_swift-node'

interface CachedSwiftBuild {
  fingerprint: string
  promise: Promise<void>
}

const swiftBuilds = new Map<string, CachedSwiftBuild>()

export interface SwiftNodeNativeAssetsOptions {
  /** Project directory containing package.json. Defaults to the current directory. */
  cwd?: string
  /** Run the project-local `swift-node build` command before emitting assets. Defaults to true. */
  build?: boolean
  /** Generated directory written by Swift Node. Defaults to `dist_swift-node`. */
  generatedDirectory?: string
  /** Relative output directory for native assets. Defaults to the bundle root. */
  assetDirectory?: string
}

interface PackageManifest {
  bin?: string | Record<string, string>
  name?: string
}

function packageManifest(projectDir: string): PackageManifest {
  const packagePath = path.join(projectDir, 'package.json')
  if (!existsSync(packagePath)) {
    throw new Error(`No package.json found at ${packagePath}.`)
  }

  return JSON.parse(readFileSync(packagePath, 'utf8')) as PackageManifest
}

export function moduleNameForPackage(packageName: string): string {
  const withoutScope = packageName.replace(/^@[^/]+\//, '')
  return withoutScope.replace(/-/g, '_')
}

export function projectModuleName(projectDir: string): string {
  const { name } = packageManifest(projectDir)
  if (!name || typeof name !== 'string') {
    throw new Error(`package.json at ${projectDir} must contain a string name.`)
  }

  return moduleNameForPackage(name)
}

/**
 * Returns only target-qualified binaries generated for this package. This
 * intentionally rejects unrelated .node files and supports future platform
 * and architecture spellings without a fixed target list.
 */
export function findNativeBinaries(
  projectDir: string,
  generatedDirectory = generatedDirectoryName,
): string[] {
  const moduleName = projectModuleName(projectDir)
  const directory = path.resolve(projectDir, generatedDirectory)
  if (!existsSync(directory)) {
    throw new Error(
      `Swift Node output is missing at ${directory}. Run swift-node build before bundling.`,
    )
  }

  const binaries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9]+-[a-z0-9-]+$/i.test(entry.name))
    .map((entry) => path.join(directory, entry.name, `${moduleName}.${entry.name}.node`))
    .filter((binaryPath) => existsSync(binaryPath))
    .sort()

  if (binaries.length === 0) {
    throw new Error(
      `No target-qualified Swift Node binary for ${moduleName} was found in ${directory}.`,
    )
  }

  return binaries
}

/**
 * Swift Node itself writes these sidecars while linking a Linux or Windows
 * addon. They are dynamic Swift runtime libraries, not arbitrary Node addons,
 * and must accompany the selected `.node` file in a bundled package.
 */
export function findSwiftRuntimeLibraries(
  projectDir: string,
  generatedDirectory = generatedDirectoryName,
): string[] {
  return findNativeBinaries(projectDir, generatedDirectory)
    .flatMap((binaryPath) => {
      const directory = path.dirname(binaryPath)
      return readdirSync(directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            (entry.name.toLowerCase().endsWith('.dll') || /\.so(?:\..+)?$/i.test(entry.name)),
        )
        .map((entry) => path.join(directory, entry.name))
    })
    .sort()
}

export function swiftWatchFiles(projectDir: string): string[] {
  const sourceDirectory = path.join(projectDir, 'src')
  const swiftSources = existsSync(sourceDirectory)
    ? readdirSync(sourceDirectory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.swift'))
        .map((entry) => path.join(sourceDirectory, entry.name))
    : []

  return [
    path.join(projectDir, 'package.json'),
    ...(existsSync(sourceDirectory) ? [sourceDirectory] : []),
    ...swiftSources,
  ]
}

/**
 * A content fingerprint keeps parallel output formats on one Swift build while
 * recompiling when a subsequent long-running bundler observes changed Swift
 * sources or package metadata.
 */
export function swiftBuildFingerprint(projectDir: string): string {
  const hash = createHash('sha256')
  const sourceDirectory = path.join(projectDir, 'src')
  for (const file of swiftWatchFiles(projectDir).filter((file) => file !== sourceDirectory)) {
    hash.update(path.relative(projectDir, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Return an output-relative filename without allowing traversal outside it. */
export function nativeAssetFileName(
  binaryPath: string,
  assetDirectory?: string,
  generatedDirectory?: string,
): string {
  const relativePath = generatedDirectory
    ? path.relative(path.resolve(generatedDirectory), binaryPath).replaceAll(path.sep, '/')
    : path.basename(binaryPath)
  const normalizedRelativePath = path.posix.normalize(relativePath.replaceAll('\\', '/'))
  if (
    path.posix.isAbsolute(normalizedRelativePath) ||
    normalizedRelativePath === '..' ||
    normalizedRelativePath.startsWith('../')
  ) {
    throw new Error('Native asset must be inside the generated Swift Node output directory.')
  }
  if (!assetDirectory) return normalizedRelativePath
  const normalized = path.posix.normalize(assetDirectory.replaceAll('\\', '/'))
  if (
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error('assetDirectory must be a relative directory inside the bundler output.')
  }
  return path.posix.join(normalized, normalizedRelativePath)
}

function swiftNodeBin(projectDir: string): string {
  const requireFromProject = createRequire(path.join(projectDir, 'package.json'))
  let swiftNodePackagePath: string
  try {
    swiftNodePackagePath = requireFromProject.resolve('swift-node/package.json')
  } catch {
    throw new Error(
      'Could not resolve the project-local swift-node package. Install swift-node as a development dependency before bundling.',
    )
  }

  const packageDirectory = path.dirname(swiftNodePackagePath)
  const swiftNodePackage = JSON.parse(readFileSync(swiftNodePackagePath, 'utf8')) as PackageManifest
  const bin =
    typeof swiftNodePackage.bin === 'string'
      ? swiftNodePackage.bin
      : swiftNodePackage.bin?.['swift-node']
  if (!bin) {
    throw new Error(`swift-node at ${swiftNodePackagePath} does not declare a swift-node binary.`)
  }

  const binPath = path.resolve(packageDirectory, bin)
  if (!existsSync(binPath)) {
    throw new Error(`The project-local swift-node binary does not exist at ${binPath}.`)
  }

  return binPath
}

/** Runs the package-installed Swift Node CLI directly, without npx or a package-manager shim. */
export async function runSwiftNodeBuild(projectDir: string): Promise<void> {
  const bin = swiftNodeBin(projectDir)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'build'], {
      cwd: projectDir,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new Error(
          `swift-node build failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}.`,
        ),
      )
    })
  })
}

/**
 * Runs one Swift build per project in the current bundler process. tsdown
 * invokes the Rolldown plugin once for each output format, but both formats
 * consume the same generated Swift Node runtime and native binary.
 */
export async function ensureSwiftNodeBuild(projectDir: string): Promise<void> {
  const key = path.resolve(projectDir)
  const fingerprint = swiftBuildFingerprint(key)
  let build = swiftBuilds.get(key)
  if (!build || build.fingerprint !== fingerprint) {
    build = { fingerprint, promise: runSwiftNodeBuild(key) }
    swiftBuilds.set(key, build)
  }

  try {
    await build.promise
  } catch (error) {
    if (swiftBuilds.get(key) === build) swiftBuilds.delete(key)
    throw error
  }
}

/** Marks a watched Swift project dirty so its next bundler pass recompiles it. */
export function invalidateSwiftNodeBuild(projectDir: string): void {
  swiftBuilds.delete(path.resolve(projectDir))
}
