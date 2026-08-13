import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { readNativeBuildManifest, writeNativeBuildManifest } from '../src/build-cache'
import { cmdBuild, type BuildDependencies } from '../src/cli'

function withProject(callback: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-build-cache-'))
  try {
    mkdirSync(path.join(projectDir, 'src'))
    writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
    writeFileSync(
      path.join(projectDir, 'src', 'native.swift'),
      '// @swift-node:export\nfunc value() -> Int { 1 }\n',
    )
    callback(projectDir)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
}

function fakeBuildDependencies(
  calls: { swift: number; cpp: number; link: number },
  target = 'target-a',
  compileTarget = 'compile-target-a',
): BuildDependencies {
  return {
    toolchainIdentity: () => ({
      swiftc: 'Swift version 6.1',
      clang: 'Apple clang version 17',
      ...(target === 'target-a' ? {} : { swiftc: `Swift version 6.1 (${target})` }),
    }),
    compileTargetIdentity: () => ({
      developerDir: compileTarget,
      nodeHeaders: 'node headers',
      nodeImportLibrary: 'node import library',
      sdkRoot: 'sdk root',
      toolchains: 'toolchains',
      swiftFlags: 'swift flags',
      cFlags: 'c flags',
      cxxFlags: 'cxx flags',
      ldFlags: 'ld flags',
    }),
    compileSwift(config) {
      calls.swift += 1
      const output = path.join(config.objDir, 'swift.o')
      writeFileSync(output, 'swift object')
      return output
    },
    compileCpp(config) {
      calls.cpp += 1
      const output = path.join(config.objDir, 'addon.o')
      writeFileSync(output, 'C++ object')
      return output
    },
    link(config) {
      calls.link += 1
      const output = path.join(config.buildDir, config.binaryName)
      mkdirSync(config.buildDir, { recursive: true })
      writeFileSync(output, `native build ${calls.link}`)
      return output
    },
  }
}

function buildOutput(projectDir: string, name = 'my_addon'): string {
  const target = `${process.platform}-${process.arch}`
  return path.join(
    projectDir,
    'dist_swift-node',
    process.platform === 'darwin' ? `${name}.${target}.node` : target,
    process.platform === 'darwin' ? '' : `${name}.${target}.node`,
  )
}

describe('native build manifest', () => {
  it('skips swiftc, clang++, and linking when the previous native build is unchanged', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)

      cmdBuild(projectDir, dependencies)
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 1, cpp: 1, link: 1 })
      expect(readNativeBuildManifest(path.join(projectDir, 'dist_swift-node'))).not.toBeNull()
    })
  })

  it('uses content rather than source timestamps to validate a cache hit', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const source = path.join(projectDir, 'src', 'native.swift')

      cmdBuild(projectDir, dependencies)
      utimesSync(source, new Date(), new Date(Date.now() + 60_000))
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 1, cpp: 1, link: 1 })
    })
  })

  it('rebuilds when the manifest is malformed', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')

      cmdBuild(projectDir, dependencies)
      writeFileSync(path.join(generatedDirectory, '.swift-node-build.json'), '{')
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 2, cpp: 2, link: 2 })
    })
  })

  it('rebuilds when the manifest path is replaced with a directory or symlink', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      const manifestFile = path.join(generatedDirectory, '.swift-node-build.json')

      cmdBuild(projectDir, dependencies)
      rmSync(manifestFile)
      mkdirSync(manifestFile)
      cmdBuild(projectDir, dependencies)
      expect(calls).toEqual({ swift: 2, cpp: 2, link: 2 })

      if (process.platform === 'win32') return

      const externalManifest = path.join(projectDir, 'external-manifest')
      const externalContents = readFileSync(manifestFile, 'utf8')
      writeFileSync(externalManifest, externalContents)
      rmSync(manifestFile)
      symlinkSync(externalManifest, manifestFile)

      expect(readNativeBuildManifest(generatedDirectory)).toBeNull()
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 3, cpp: 3, link: 3 })
      expect(readFileSync(externalManifest, 'utf8')).toBe(externalContents)
    })
  })

  it('rebuilds when Swift content or native package/toolchain target configuration changes', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      cmdBuild(projectDir, fakeBuildDependencies(calls))
      const originalBinary = buildOutput(projectDir)

      writeFileSync(
        path.join(projectDir, 'src', 'native.swift'),
        '// @swift-node:export\nfunc value() -> Int { 2 }\n',
      )
      cmdBuild(projectDir, fakeBuildDependencies(calls))

      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'renamed-addon' }),
      )
      cmdBuild(projectDir, fakeBuildDependencies(calls))
      expect(existsSync(originalBinary)).toBe(false)

      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'renamed-addon', swiftNode: { shipSwiftRuntime: false } }),
      )
      cmdBuild(projectDir, fakeBuildDependencies(calls))

      cmdBuild(projectDir, fakeBuildDependencies(calls, 'target-b'))

      cmdBuild(projectDir, fakeBuildDependencies(calls, 'target-b', 'compile-target-b'))

      expect(calls).toEqual({ swift: 6, cpp: 6, link: 6 })
    })
  })

  it('rebuilds when a generated runtime file is deleted or its native binary is altered', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')

      cmdBuild(projectDir, dependencies)
      unlinkSync(path.join(generatedDirectory, 'index.mjs'))
      cmdBuild(projectDir, dependencies)

      const binary = buildOutput(projectDir)
      expect(existsSync(binary)).toBe(true)
      writeFileSync(binary, 'tampered')
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 3, cpp: 3, link: 3 })
      expect(readFileSync(binary, 'utf8')).toBe('native build 3')
    })
  })

  it('rebuilds normally when an expected generated output is replaced with a directory', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const binary = buildOutput(projectDir)

      cmdBuild(projectDir, dependencies)
      rmSync(binary)
      mkdirSync(binary)
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 2, cpp: 2, link: 2 })
      expect(readFileSync(binary, 'utf8')).toBe('native build 2')
    })
  })

  it('rebuilds when an output is reached through a symlinked generated directory', () => {
    if (process.platform === 'win32') return

    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      const movedOutput = path.join(projectDir, 'moved-output')

      cmdBuild(projectDir, dependencies)
      rmSync(movedOutput, { recursive: true, force: true })
      // Moving first preserves the manifest and exact file hashes: only the
      // unsafe symlink must invalidate this otherwise cache-valid artifact.
      const files = [
        '.swift-node-build.json',
        'index.d.ts',
        'index.d.cts',
        'index.d.mts',
        'index.mjs',
        'index.cjs',
        path.relative(generatedDirectory, buildOutput(projectDir)),
      ]
      mkdirSync(movedOutput, { recursive: true })
      for (const file of files) {
        const source = path.join(generatedDirectory, file)
        const destination = path.join(movedOutput, file)
        mkdirSync(path.dirname(destination), { recursive: true })
        writeFileSync(destination, readFileSync(source))
      }
      rmSync(generatedDirectory, { recursive: true, force: true })
      symlinkSync(movedOutput, generatedDirectory, 'dir')

      const manifest = readNativeBuildManifest(generatedDirectory)
      expect(manifest).not.toBeNull()
      expect(() =>
        writeNativeBuildManifest(
          generatedDirectory,
          manifest!.inputs,
          manifest!.configuration,
          Object.keys(manifest!.outputs),
        ),
      ).toThrow('unsafe generated output directory')

      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 2, cpp: 2, link: 2 })
      expect(readFileSync(buildOutput(projectDir), 'utf8')).toBe('native build 2')
    })
  })

  it('does not follow a pre-existing manifest temporary-file symlink', () => {
    if (process.platform === 'win32') return

    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      const outside = path.join(projectDir, 'outside-manifest')

      cmdBuild(projectDir, dependencies)
      const manifest = readNativeBuildManifest(generatedDirectory)!
      const temporary = path.join(
        generatedDirectory,
        `.swift-node-build.json.${process.pid}.injected.tmp`,
      )
      writeFileSync(outside, 'outside content')
      symlinkSync(outside, temporary)

      expect(
        writeNativeBuildManifest(
          generatedDirectory,
          manifest.inputs,
          manifest.configuration,
          Object.keys(manifest.outputs),
        ),
      ).toBeUndefined()
      expect(readFileSync(outside, 'utf8')).toBe('outside content')
      expect(existsSync(temporary)).toBe(true)
    })
  })

  it('publishes a manifest despite a stale temporary file from a crashed build', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')

      cmdBuild(projectDir, dependencies)
      writeFileSync(
        path.join(generatedDirectory, `.swift-node-build.json.${process.pid}.stale.tmp`),
        'stale temporary file',
      )
      writeFileSync(
        path.join(projectDir, 'src', 'native.swift'),
        '// @swift-node:export\nfunc value() -> Int { 2 }\n',
      )

      cmdBuild(projectDir, dependencies)

      expect(readNativeBuildManifest(generatedDirectory)).not.toBeNull()
    })
  })

  it('does not leave a valid manifest when linking fails', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      cmdBuild(projectDir, fakeBuildDependencies(calls))
      writeFileSync(
        path.join(projectDir, 'src', 'native.swift'),
        '// @swift-node:export\nfunc value() -> Int { 2 }\n',
      )

      const failingDependencies = fakeBuildDependencies(calls)
      failingDependencies.link = () => {
        calls.link += 1
        throw new Error('link failed')
      }

      expect(() => cmdBuild(projectDir, failingDependencies)).toThrow('link failed')
      expect(readNativeBuildManifest(path.join(projectDir, 'dist_swift-node'))).toBeNull()
      expect(existsSync(path.join(projectDir, '.swift-node-build.lock'))).toBe(false)
    })
  })

  it('does not publish a manifest when a source changes during compilation', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const source = path.join(projectDir, 'src', 'native.swift')
      let compiledSources: string[] = []
      const compileSwift = dependencies.compileSwift!
      dependencies.compileSwift = (config) => {
        compiledSources = [...config.swiftSources]
        writeFileSync(source, '// @swift-node:export\nfunc value() -> Int { 2 }\n')
        return compileSwift(config)
      }

      cmdBuild(projectDir, dependencies)

      expect(compiledSources).toContain(path.join('src', 'native.swift'))
      expect(readNativeBuildManifest(path.join(projectDir, 'dist_swift-node'))).toBeNull()
    })
  })

  it('recovers an ownerless native build lock left before ownership was recorded', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const lock = path.join(projectDir, '.swift-node-build.lock')
      mkdirSync(lock)
      utimesSync(lock, new Date(0), new Date(0))

      cmdBuild(projectDir, fakeBuildDependencies(calls))

      expect(calls).toEqual({ swift: 1, cpp: 1, link: 1 })
      expect(existsSync(lock)).toBe(false)
    })
  })

  it('recovers an ancient lock whose dead owner PID was reused', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const lock = path.join(projectDir, '.swift-node-build.lock')
      mkdirSync(lock)
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }))
      utimesSync(lock, new Date(0), new Date(0))

      cmdBuild(projectDir, fakeBuildDependencies(calls))

      expect(calls).toEqual({ swift: 1, cpp: 1, link: 1 })
      expect(existsSync(lock)).toBe(false)
    })
  })

  it('publishes a cache entry after a source is added during cache-hit validation', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const firstBuild = fakeBuildDependencies(calls)
      cmdBuild(projectDir, firstBuild)

      let toolchainReads = 0
      const dependencies = fakeBuildDependencies(calls)
      dependencies.toolchainIdentity = () => {
        toolchainReads += 1
        if (toolchainReads === 1) {
          writeFileSync(
            path.join(projectDir, 'src', 'added.swift'),
            '// @swift-node:export\nfunc added() -> Int { 2 }\n',
          )
        }
        return { swiftc: 'Swift version 6.1', clang: 'Apple clang version 17' }
      }

      cmdBuild(projectDir, dependencies)
      cmdBuild(projectDir, dependencies)

      expect(calls).toEqual({ swift: 2, cpp: 2, link: 2 })
    })
  })

  it('removes stale Swift runtime sidecars when the runtime is no longer shipped', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      cmdBuild(projectDir, fakeBuildDependencies(calls))
      const runtimeSidecar = path.join(path.dirname(buildOutput(projectDir)), 'libswiftCore.so.6')
      writeFileSync(runtimeSidecar, 'stale runtime')

      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'my-addon', swiftNode: { shipSwiftRuntime: false } }),
      )
      cmdBuild(projectDir, fakeBuildDependencies(calls))

      expect(existsSync(runtimeSidecar)).toBe(false)
    })
  })

  it('preserves a macOS binary for another architecture while rebuilding this target', () => {
    if (process.platform !== 'darwin') return

    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      const dependencies = fakeBuildDependencies(calls)
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      const otherArchitecture = process.arch === 'arm64' ? 'x64' : 'arm64'
      const otherBinary = path.join(generatedDirectory, `my_addon.darwin-${otherArchitecture}.node`)

      cmdBuild(projectDir, dependencies)
      writeFileSync(otherBinary, 'other architecture')
      writeFileSync(
        path.join(projectDir, 'src', 'native.swift'),
        '// @swift-node:export\nfunc value() -> Int { 2 }\n',
      )
      cmdBuild(projectDir, dependencies)

      expect(readFileSync(otherBinary, 'utf8')).toBe('other architecture')
    })
  })
})
