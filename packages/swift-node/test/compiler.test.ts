import { describe, expect, it } from 'vite-plus/test'
import {
  copySwiftRuntimeLibraries,
  cppCompileArgs,
  getNodeImportLibrary,
  getNodeInclude,
  isSupportedPlatform,
  linkCommand,
  macosDeploymentTarget,
  needsNodeGypInstall,
  nodeGypDevDir,
  swiftCompileArgs,
} from '../src/compiler'

const config = {
  moduleName: 'hello-world',
  binaryName: 'hello-world.darwin-arm64.node',
  swiftSources: ['src/native.swift'],
  projectDir: '/project',
  intermediateDir: '/project/intermediate',
  buildDir: '/project/dist',
  objDir: '/project/build',
  runtimeDir: '/runtime',
  minMacosVersion: '13.0',
  shipSwiftRuntime: true,
}

describe('cross-platform compiler commands', () => {
  it('recognizes each supported host platform', () => {
    expect(isSupportedPlatform('darwin')).toBe(true)
    expect(isSupportedPlatform('linux')).toBe(true)
    expect(isSupportedPlatform('win32')).toBe(true)
    expect(isSupportedPlatform('freebsd')).toBe(false)
  })

  it('uses the macOS deployment target only on macOS', () => {
    expect(swiftCompileArgs(config, 'darwin', 'arm64')).toContain('-target')
    expect(swiftCompileArgs(config, 'darwin', 'arm64')).toContain('arm64-apple-macosx13.0')
    expect(swiftCompileArgs(config, 'linux')).not.toContain('-target')
    expect(swiftCompileArgs(config, 'win32')).not.toContain('-target')
    expect(cppCompileArgs(config, 'darwin')).toContain('-mmacosx-version-min=13.0')
    expect(linkCommand(config, ['swift.o', 'addon.o'], 'darwin', 'arm64').args).toContain(
      'arm64-apple-macosx13.0',
    )
  })

  it('uses the configured deployment target consistently on Apple Silicon', () => {
    expect(macosDeploymentTarget('10.15', 'arm64')).toBe('10.15')
    expect(macosDeploymentTarget('10.15', 'x64')).toBe('10.15')
    expect(swiftCompileArgs({ ...config, minMacosVersion: '10.15' }, 'darwin', 'arm64')).toContain(
      'arm64-apple-macosx10.15',
    )
  })

  it('uses platform-compatible C++ object settings', () => {
    expect(cppCompileArgs(config, 'darwin')).toContain('-fPIC')
    expect(cppCompileArgs(config, 'linux')).toContain('-fPIC')
    const windowsArgs = cppCompileArgs(config, 'win32', 'C:\\node-headers')
    expect(windowsArgs).not.toContain('-fPIC')
    expect(windowsArgs).toContain('-fms-runtime-lib=dll')
    expect(cppCompileArgs(config, 'darwin')).not.toContain('-fms-runtime-lib=dll')
  })

  it('finds node-gyp headers when the Windows Node archive has no include directory', () => {
    const headers = 'C:\\Users\\runneradmin\\.swift-node\\node-gyp\\24.18.0\\include\\node'
    const options = {
      platform: 'win32' as const,
      execPath: 'C:\\hostedtoolcache\\windows\\node\\24.18.0\\x64\\node.exe',
      nodeVersion: '24.18.0',
      homeDir: 'C:\\Users\\runneradmin',
      env: {},
      fileExists: (file: string) => file === `${headers}\\node_api.h`,
    }

    expect(nodeGypDevDir(options.platform, options.homeDir)).toBe(
      'C:\\Users\\runneradmin\\.swift-node\\node-gyp',
    )
    expect(getNodeInclude(options)).toBe(headers)
  })

  it('finds node-gyp import libraries when the Windows Node archive has no node.lib', () => {
    const library = 'C:\\Users\\runneradmin\\.swift-node\\node-gyp\\24.18.0\\x64\\node.lib'
    expect(
      getNodeImportLibrary({
        platform: 'win32',
        execPath: 'C:\\hostedtoolcache\\windows\\node\\24.18.0\\x64\\node.exe',
        nodeVersion: '24.18.0',
        arch: 'x64',
        homeDir: 'C:\\Users\\runneradmin',
        fileExists: (file) => file === library,
      }),
    ).toBe(library)
  })

  it('installs Node development files on Windows when headers exist but node.lib does not', () => {
    const headers = 'C:\\sdk\\include\\node'
    const options = {
      platform: 'win32' as const,
      execPath: 'C:\\node\\node.exe',
      nodeVersion: '24.18.0',
      arch: 'x64',
      homeDir: 'C:\\Users\\runneradmin',
      env: { npm_config_nodedir: 'C:\\sdk' },
      fileExists: (file: string) => file === `${headers}\\node_api.h`,
    }

    expect(getNodeImportLibrary(options)).toBeNull()
    expect(needsNodeGypInstall(options)).toBe(true)
  })

  it('does not redownload Windows development files when headers and node.lib exist', () => {
    const headers = 'C:\\sdk\\include\\node'
    const library = 'C:\\node\\node.lib'
    const options = {
      platform: 'win32' as const,
      execPath: 'C:\\node\\node.exe',
      nodeVersion: '24.18.0',
      arch: 'x64',
      homeDir: 'C:\\Users\\runneradmin',
      env: { npm_config_nodedir: 'C:\\sdk' },
      fileExists: (file: string) => file === `${headers}\\node_api.h` || file === library,
    }

    expect(needsNodeGypInstall(options)).toBe(false)
  })

  it('copies every Swift runtime DLL beside a Windows prebuild', () => {
    const copied: Array<[string, string]> = []
    const output = 'C:\\project\\dist_swift-node'
    const runtime = 'C:\\Swift\\usr\\lib\\swift\\windows'
    const targetInfo = JSON.stringify({ paths: { runtimeLibraryPaths: [runtime] } })

    expect(
      copySwiftRuntimeLibraries(output, {
        platform: 'win32',
        targetInfo,
        readDirectory: () => ['swiftCore.dll', 'Foundation.dll', 'swiftc.exe'],
        copyFile(source, destination) {
          copied.push([source, destination])
        },
        makeDirectory() {},
      }),
    ).toEqual(['swiftcore.dll', 'foundation.dll'])
    expect(copied).toEqual([
      [`${runtime}\\swiftCore.dll`, `${output}\\swiftCore.dll`],
      [`${runtime}\\Foundation.dll`, `${output}\\Foundation.dll`],
    ])
  })

  it('copies shared-object Swift runtime libraries beside a Linux prebuild', () => {
    const copied: Array<[string, string]> = []
    const output = '/project/dist_swift-node'
    const runtime = '/usr/lib/swift/linux'
    const targetInfo = JSON.stringify({ paths: { runtimeLibraryPaths: [runtime] } })

    expect(
      copySwiftRuntimeLibraries(output, {
        platform: 'linux',
        targetInfo,
        readDirectory: () => ['libswiftCore.so', 'libswiftCore.so.6.0.1', 'swiftc'],
        copyFile(source, destination) {
          copied.push([source, destination])
        },
        makeDirectory() {},
      }),
    ).toEqual(['libswiftcore.so', 'libswiftcore.so.6.0.1'])
    expect(copied).toEqual([
      [`${runtime}/libswiftCore.so`, `${output}/libswiftCore.so`],
      [`${runtime}/libswiftCore.so.6.0.1`, `${output}/libswiftCore.so.6.0.1`],
    ])
  })

  it('uses the platform linker strategy', () => {
    expect(linkCommand(config, ['swift.o', 'addon.o'], 'darwin')).toMatchObject({
      command: 'clang++',
      args: expect.arrayContaining(['-undefined', 'dynamic_lookup']),
    })
    expect(linkCommand(config, ['swift.o', 'addon.o'], 'linux')).toMatchObject({
      command: 'swiftc',
      args: expect.arrayContaining([
        '-emit-library',
        '--unresolved-symbols=ignore-all',
        '-rpath',
        '$ORIGIN',
      ]),
    })
    expect(linkCommand(config, ['swift.o', 'addon.o'], 'win32')).toMatchObject({
      command: 'swiftc',
      args: expect.arrayContaining(['-emit-library', expect.stringMatching(/node\.lib$/)]),
    })
    expect(() => linkCommand(config, ['swift.o', 'addon.o'], 'freebsd')).toThrow(
      'Unsupported platform',
    )
  })

  it('links directly to the configured target-qualified binary', () => {
    expect(linkCommand(config, ['swift.o', 'addon.o'], 'darwin').args).toContain(
      '/project/dist/hello-world.darwin-arm64.node',
    )
  })
})
