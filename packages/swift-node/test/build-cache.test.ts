import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { readNativeBuildManifest } from '../src/build-cache'
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
): BuildDependencies {
  return {
    toolchainIdentity: () => ({
      swiftc: 'Swift version 6.1',
      clang: 'Apple clang version 17',
      ...(target === 'target-a' ? {} : { swiftc: `Swift version 6.1 (${target})` }),
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

      expect(calls).toEqual({ swift: 5, cpp: 5, link: 5 })
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
    })
  })

  it('removes stale Swift runtime sidecars when the runtime is no longer shipped', () => {
    withProject((projectDir) => {
      const calls = { swift: 0, cpp: 0, link: 0 }
      cmdBuild(projectDir, fakeBuildDependencies(calls))
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      const runtimeSidecar = path.join(generatedDirectory, 'libswiftCore.so.6')
      writeFileSync(runtimeSidecar, 'stale runtime')

      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'my-addon', swiftNode: { shipSwiftRuntime: false } }),
      )
      cmdBuild(projectDir, fakeBuildDependencies(calls))

      expect(existsSync(runtimeSidecar)).toBe(false)
    })
  })
})
