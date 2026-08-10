#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  mkdtempSync,
  rmSync,
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
import { compileSwift, compileCpp, getNodeInclude, isSupportedPlatform, link } from './compiler.js'
import { validateExports } from './validator.js'
import {
  configureYarn,
  findAvailablePackageManagers,
  PackageManager,
  PackageManagerName,
} from './package-manager.js'
import { executableForPlatform, executionOptionsForPlatform } from './command.js'
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

const args = process.argv.slice(2)
const command = args[0]
const generatedDirName = 'dist_swift-node'

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.1'
  } catch {
    return '0.0.1'
  }
}

void run()

async function run() {
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
  execFileSync(executableForPlatform(command), commandArgs, {
    cwd: projectDir,
    stdio: 'inherit',
    ...executionOptionsForPlatform(command),
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

async function cmdInit(initArgs: string[]) {
  if (initArgs.length > 1) {
    throw new Error('Usage: swift-node init [package-name|.]')
  }

  const cwd = process.cwd()
  const requestedPackageName = initArgs[0]
  const interactive = canPrompt()

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
  const availablePackageManagers =
    interactive && createsPackageManifest ? findAvailablePackageManagers() : []
  const packageManager =
    availablePackageManagers.length > 0
      ? await promptForPackageManager(availablePackageManagers)
      : undefined
  const useTsdown = interactive && createsPackageManifest ? await promptToUseTsdown() : false
  const prebuildTargets =
    interactive && createsPackageManifest ? await promptForPrebuildTargets() : []
  const shipSwiftRuntime = prebuildTargets.length > 0 ? await promptToShipSwiftRuntime() : true
  const createPrebuildWorkflow =
    prebuildTargets.length > 0 ? await promptToCreatePrebuildWorkflow() : false
  const publishPrebuildPackage = createPrebuildWorkflow
    ? await promptToPublishPrebuildPackage()
    : false
  const buildNow =
    interactive && createsPackageManifest && packageManager ? await promptToBuild() : false

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
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : ''
  const gitignoreLines = new Set(gitignore.split(/\r?\n/))
  const missingIgnores = ['dist_swift-node/', ...(useTsdown ? ['dist/'] : [])].filter(
    (entry) => !gitignoreLines.has(entry),
  )
  if (missingIgnores.length > 0) {
    const prefix = gitignore.length === 0 || gitignore.endsWith('\n') ? '' : '\n'
    writeFileSync(gitignorePath, gitignore + prefix + missingIgnores.join('\n') + '\n')
    console.log('Updated .gitignore')
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

function cmdBuild(cwd = process.cwd()) {
  if (!isSupportedPlatform()) {
    console.error(
      `Error: swift-node build supports macOS, Linux, and Windows; received ${process.platform}.`,
    )
    process.exit(1)
  }
  const config = readConfig(cwd)

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
      console.error(`Error: Swift source not found: ${src}`)
      process.exit(1)
    }
    const source = readFileSync(fullPath, 'utf-8')
    allSources.set(src, source)
    const structs = parseSwiftStructs(source)
    const exported = parseExportedFunctions(source)
    const codableTypes = parseSwiftCodableTypes(source)
    allStructs.push(...structs)
    allExported.push(...exported)
    allCodableTypes.push(...codableTypes)
  }

  // Validate export annotations
  if (allExported.length > 0) {
    let hasErrors = false
    for (const [src, source] of allSources) {
      const exported = parseExportedFunctions(source)
      if (exported.length === 0) continue
      const errors = validateExports(
        exported,
        source,
        allStructs.map((struct) => struct.name),
        allCodableTypes,
      )
      for (const err of errors) {
        console.error(
          `${err.severity === 'error' ? 'Error' : 'Warning'}: ${src}:${err.line}: ${err.message}`,
        )
        if (err.severity === 'error') hasErrors = true
      }
    }
    if (hasErrors) {
      process.exit(1)
    }
  }

  // Convert exported functions to SwiftFunction[] for the C++ generator
  const codableNames = allCodableTypes.map((type) => type.name)
  allFunctions = exportedToSwiftFunctions(allExported, config.moduleName, allStructs, codableNames)

  if (allFunctions.length === 0) {
    console.error('Error: No exported functions found in Swift sources.')
    console.error('Add // @swift-node:export above a Swift function.')
    process.exit(1)
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
  const generatedDir = path.join(cwd, generatedDirName)
  // macOS has no bundled Swift runtime sidecars, so its target-qualified
  // binaries can live directly beside the generated runtime. Linux and
  // Windows keep a target directory because their Swift runtime libraries
  // must be loaded from the same directory as the addon.
  const nativeOutputDir =
    process.platform === 'darwin' ? generatedDir : path.join(generatedDir, nativeTargetId())
  const scratchDir = mkdtempSync(path.join(tmpdir(), 'swift-node-build-'))
  mkdirSync(generatedDir, { recursive: true })
  mkdirSync(nativeOutputDir, { recursive: true })

  try {
    const runtimeDir = path.resolve(__dirname, '..', 'runtime')

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

    // Keep only the generated runtime API in the project. These files are
    // required both for local use and for a package assembled from target builds.
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

    // 3. Compile & link. Object files belong with the temporary bridge code.
    const swiftSources = [...config.swiftSources]
    if (wrappersSwiftPath) swiftSources.push(wrappersSwiftPath)

    const compilerConfig = {
      moduleName: config.moduleName,
      binaryName: prebuildFilename(config.moduleName),
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
    const swiftObj = compileSwift(compilerConfig)

    console.log('  Compiling C++...')
    const cppObj = compileCpp(compilerConfig)

    console.log('  Linking...')
    const nodeFile = link(compilerConfig, [swiftObj, cppObj])

    console.log(`\n  ✓ Built: ${path.relative(cwd, nodeFile)}`)
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
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
