import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import {
  findNativeBinaries,
  findSwiftRuntimeLibraries,
  moduleNameForPackage,
  nativeAssetFileName,
  runSwiftNodeBuild,
  swiftBuildFingerprint,
  swiftWatchFiles,
} from '../src/core'

function withProject(callback: (projectDir: string) => void | Promise<void>): Promise<void> {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-unplugin-'))
  return Promise.resolve(callback(projectDir)).finally(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })
}

function writePackage(projectDir: string, name = '@scope/my-addon'): void {
  writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name }))
}

describe('Swift Node artifact discovery', () => {
  it('derives the same module name as swift-node', () => {
    expect(moduleNameForPackage('@scope/my-addon')).toBe('my_addon')
    expect(moduleNameForPackage('my-addon')).toBe('my_addon')
  })

  it('emits only target-qualified binaries for the current package', async () => {
    await withProject((projectDir) => {
      writePackage(projectDir)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      mkdirSync(generatedDirectory)
      const darwinDirectory = path.join(generatedDirectory, 'darwin-arm64')
      const linuxDirectory = path.join(generatedDirectory, 'linux-x64')
      mkdirSync(darwinDirectory)
      mkdirSync(linuxDirectory)
      writeFileSync(path.join(darwinDirectory, 'my_addon.darwin-arm64.node'), 'darwin')
      writeFileSync(path.join(linuxDirectory, 'my_addon.linux-x64.node'), 'linux')
      writeFileSync(path.join(generatedDirectory, 'my_addon.node'), 'legacy')
      writeFileSync(path.join(generatedDirectory, 'other.darwin-arm64.node'), 'other')
      writeFileSync(path.join(generatedDirectory, 'my_addon.notes.txt'), 'not native')

      expect(findNativeBinaries(projectDir).map((file) => path.basename(file))).toEqual([
        'my_addon.darwin-arm64.node',
        'my_addon.linux-x64.node',
      ])
    })
  })

  it('finds only generated Swift runtime sidecars', async () => {
    await withProject((projectDir) => {
      writePackage(projectDir)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      mkdirSync(generatedDirectory)
      const linuxDirectory = path.join(generatedDirectory, 'linux-x64')
      const windowsDirectory = path.join(generatedDirectory, 'win32-x64')
      mkdirSync(linuxDirectory)
      mkdirSync(windowsDirectory)
      writeFileSync(path.join(linuxDirectory, 'libswiftCore.so.6'), 'swift')
      writeFileSync(path.join(windowsDirectory, 'swiftCore.dll'), 'swift')
      writeFileSync(path.join(linuxDirectory, 'my_addon.linux-x64.node'), 'addon')
      writeFileSync(path.join(windowsDirectory, 'my_addon.win32-x64.node'), 'addon')
      writeFileSync(path.join(generatedDirectory, 'notes.txt'), 'ignore')

      expect(findSwiftRuntimeLibraries(projectDir).map((file) => path.basename(file))).toEqual([
        'libswiftCore.so.6',
        'swiftCore.dll',
      ])
    })
  })

  it('watches package configuration and Swift source files', async () => {
    await withProject((projectDir) => {
      writePackage(projectDir)
      const sourceDirectory = path.join(projectDir, 'src')
      mkdirSync(sourceDirectory)
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(path.join(sourceDirectory, 'index.ts'), '')

      expect(swiftWatchFiles(projectDir)).toEqual([
        path.join(projectDir, 'package.json'),
        sourceDirectory,
        path.join(sourceDirectory, 'native.swift'),
      ])
    })
  })

  it('changes the build fingerprint when Swift source contents change', async () => {
    await withProject((projectDir) => {
      writePackage(projectDir)
      const sourceDirectory = path.join(projectDir, 'src')
      mkdirSync(sourceDirectory)
      const sourcePath = path.join(sourceDirectory, 'native.swift')
      writeFileSync(sourcePath, 'func value() -> Int { 1 }')
      const before = swiftBuildFingerprint(projectDir)
      writeFileSync(sourcePath, 'func value() -> Int { 2 }')
      expect(swiftBuildFingerprint(projectDir)).not.toBe(before)
    })
  })

  it('keeps native assets inside the bundler output', () => {
    expect(nativeAssetFileName('/output/my_addon.darwin-arm64.node')).toBe(
      'my_addon.darwin-arm64.node',
    )
    expect(nativeAssetFileName('/output/my_addon.darwin-arm64.node', 'server/native')).toBe(
      'server/native/my_addon.darwin-arm64.node',
    )
    expect(
      nativeAssetFileName('/output/darwin-arm64/my_addon.darwin-arm64.node', 'server', '/output'),
    ).toBe('server/darwin-arm64/my_addon.darwin-arm64.node')
    expect(
      nativeAssetFileName('/output/linux-x64/my_addon.linux-x64.node', 'server', '/output'),
    ).toBe('server/linux-x64/my_addon.linux-x64.node')
    expect(() => nativeAssetFileName('/output/addon.node', '../outside')).toThrow('assetDirectory')
  })
})

describe('project-local swift-node build', () => {
  it('runs the package-installed binary directly instead of npx', async () => {
    await withProject(async (projectDir) => {
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(binDirectory, { recursive: true })
      writePackage(projectDir)
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { mkdirSync, writeFileSync } from 'node:fs'\nimport path from 'node:path'\nconst output = path.join(process.cwd(), 'dist_swift-node', 'darwin-arm64')\nmkdirSync(output, { recursive: true })\nwriteFileSync(path.join(output, 'my_addon.darwin-arm64.node'), process.argv[2])\n`,
      )
      chmodSync(binPath, 0o755)

      await runSwiftNodeBuild(projectDir)

      const nativePath = path.join(
        projectDir,
        'dist_swift-node',
        'darwin-arm64',
        'my_addon.darwin-arm64.node',
      )
      expect(existsSync(nativePath)).toBe(true)
      expect(readFileSync(nativePath, 'utf8')).toBe('build')
    })
  })
})
