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
import { build } from 'tsdown'
import { describe, expect, it } from 'vite-plus/test'
import { swiftNodeNativeAssets } from '../src'

interface TestPluginContext {
  addWatchFile(file: string): void
  emitFile(asset: { fileName: string; source: Buffer }): string
}

interface TestPlugin {
  buildStart?: (this: TestPluginContext) => Promise<void> | void
  watchChange?: (id: string) => void
}

function rolldownPlugin(options: Parameters<typeof swiftNodeNativeAssets.rolldown>[0]): TestPlugin {
  const plugin = swiftNodeNativeAssets.rolldown(options)
  return (Array.isArray(plugin) ? plugin[0] : plugin) as TestPlugin
}

function withProject(callback: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-unplugin-plugin-'))
  return callback(projectDir).finally(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test build to start.')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('swiftNodeNativeAssets', () => {
  it('runs the project-local swift-node build before it emits native assets', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(sourceDirectory)
      mkdirSync(binDirectory, { recursive: true })
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { mkdirSync, writeFileSync } from 'node:fs'\nimport path from 'node:path'\nconst output = path.join(process.cwd(), 'dist_swift-node')\nmkdirSync(output, { recursive: true })\nwriteFileSync(path.join(output, 'my_addon.darwin-arm64.node'), process.argv[2])\n`,
      )
      chmodSync(binPath, 0o755)

      const plugin = rolldownPlugin({ cwd: projectDir })
      const emitted: Array<{ fileName: string; source: Buffer }> = []
      await Reflect.apply(
        plugin.buildStart!,
        {
          meta: { watchMode: false },
          addWatchFile() {},
          emitFile(asset: { fileName: string; source: Buffer }) {
            emitted.push(asset)
            return String(emitted.length)
          },
        },
        [],
      )

      expect(emitted).toHaveLength(1)
      expect(emitted[0]?.fileName).toBe('my_addon.darwin-arm64.node')
      expect(emitted[0]?.source.toString()).toBe('build')
    })
  })

  it('shares one Swift build between tsdown output formats', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(sourceDirectory)
      mkdirSync(binDirectory, { recursive: true })
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'\nimport path from 'node:path'\nconst output = path.join(process.cwd(), 'dist_swift-node')\nmkdirSync(output, { recursive: true })\nappendFileSync(path.join(process.cwd(), 'swift-builds.txt'), 'build\\n')\nwriteFileSync(path.join(output, 'my_addon.darwin-arm64.node'), 'native')\n`,
      )
      chmodSync(binPath, 0o755)

      const context = {
        addWatchFile() {},
        emitFile() {
          return 'asset'
        },
      }
      const esmPlugin = rolldownPlugin({ cwd: projectDir })
      const cjsPlugin = rolldownPlugin({ cwd: projectDir })
      await Promise.all([
        Reflect.apply(esmPlugin.buildStart!, context, []),
        Reflect.apply(cjsPlugin.buildStart!, context, []),
      ])

      expect(readFileSync(path.join(projectDir, 'swift-builds.txt'), 'utf8')).toBe('build\n')
    })
  })

  it('skips native work for TypeScript watches and reinvokes it for Swift, relevant package, and native-output changes', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(sourceDirectory)
      mkdirSync(binDirectory, { recursive: true })
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(path.join(sourceDirectory, 'index.ts'), 'export {}\n')
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const output = path.join(process.cwd(), 'dist_swift-node')
mkdirSync(output, { recursive: true })
appendFileSync(path.join(process.cwd(), 'swift-builds.txt'), 'build\\n')
writeFileSync(path.join(output, 'my_addon.darwin-arm64.node'), 'native')
`,
      )
      chmodSync(binPath, 0o755)

      const plugin = rolldownPlugin({ cwd: projectDir })
      const context = {
        addWatchFile() {},
        emitFile() {
          return 'asset'
        },
      }

      await Reflect.apply(plugin.buildStart!, context, [])
      plugin.watchChange!(path.join(sourceDirectory, 'index.ts'))
      await Reflect.apply(plugin.buildStart!, context, [])

      writeFileSync(path.join(sourceDirectory, 'native.swift'), '// changed')
      plugin.watchChange!(path.join(sourceDirectory, 'native.swift'))
      await Reflect.apply(plugin.buildStart!, context, [])

      const nativeOutput = path.join(projectDir, 'dist_swift-node', 'my_addon.darwin-arm64.node')
      writeFileSync(nativeOutput, 'changed')
      plugin.watchChange!(nativeOutput)
      await Reflect.apply(plugin.buildStart!, context, [])

      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'my-addon', swiftNode: { shipSwiftRuntime: false } }),
      )
      plugin.watchChange!(path.join(projectDir, 'package.json'))
      await Reflect.apply(plugin.buildStart!, context, [])

      expect(readFileSync(path.join(projectDir, 'swift-builds.txt'), 'utf8')).toBe(
        'build\nbuild\nbuild\nbuild\n',
      )
    })
  })

  it('does not overlap CLI builds when watch events arrive during an active build', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(sourceDirectory)
      mkdirSync(binDirectory, { recursive: true })
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const project = process.cwd()
const output = path.join(project, 'dist_swift-node')
const active = path.join(project, 'swift-build-active')
if (existsSync(active)) appendFileSync(path.join(project, 'swift-builds.txt'), 'overlap\\n')
writeFileSync(active, '')
appendFileSync(path.join(project, 'swift-builds.txt'), 'start\\n')
await new Promise((resolve) => setTimeout(resolve, 80))
mkdirSync(output, { recursive: true })
writeFileSync(path.join(output, 'my_addon.darwin-arm64.node'), 'native')
rmSync(active)
appendFileSync(path.join(project, 'swift-builds.txt'), 'end\\n')
`,
      )
      chmodSync(binPath, 0o755)

      const plugin = rolldownPlugin({ cwd: projectDir })
      const context = {
        addWatchFile() {},
        emitFile() {
          return 'asset'
        },
      }
      const firstBuild = Reflect.apply(plugin.buildStart!, context, [])
      await waitFor(() => existsSync(path.join(projectDir, 'swift-build-active')))

      // A Swift edit marks the active CLI process dirty. Both output formats
      // keep waiting for it instead of starting a second process concurrently.
      plugin.watchChange!(path.join(sourceDirectory, 'native.swift'))
      const secondFormat = Reflect.apply(plugin.buildStart!, context, [])
      await Promise.all([firstBuild, secondFormat])

      expect(readFileSync(path.join(projectDir, 'swift-builds.txt'), 'utf8')).toBe(
        'start\nend\nstart\nend\n',
      )
    })
  })

  it('ignores generated-output watch notifications from its active CLI build', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const swiftNodeDirectory = path.join(projectDir, 'node_modules', 'swift-node')
      const binDirectory = path.join(swiftNodeDirectory, 'bin')
      mkdirSync(sourceDirectory)
      mkdirSync(binDirectory, { recursive: true })
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(
        path.join(swiftNodeDirectory, 'package.json'),
        JSON.stringify({ bin: { 'swift-node': 'bin/swift-node.js' } }),
      )
      const binPath = path.join(binDirectory, 'swift-node.js')
      writeFileSync(
        binPath,
        `import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const project = process.cwd()
writeFileSync(path.join(project, 'swift-build-active'), '')
appendFileSync(path.join(project, 'swift-builds.txt'), 'build\\n')
await new Promise((resolve) => setTimeout(resolve, 80))
const output = path.join(project, 'dist_swift-node')
mkdirSync(output, { recursive: true })
writeFileSync(path.join(output, 'my_addon.darwin-arm64.node'), 'native')
rmSync(path.join(project, 'swift-build-active'))
`,
      )
      chmodSync(binPath, 0o755)

      const plugin = rolldownPlugin({ cwd: projectDir })
      const context = {
        addWatchFile() {},
        emitFile() {
          return 'asset'
        },
      }
      const build = Reflect.apply(plugin.buildStart!, context, [])
      await waitFor(() => existsSync(path.join(projectDir, 'swift-build-active')))
      plugin.watchChange!(path.join(projectDir, 'dist_swift-node', 'my_addon.darwin-arm64.node'))
      await build

      expect(readFileSync(path.join(projectDir, 'swift-builds.txt'), 'utf8')).toBe('build\n')
    })
  })

  it('does not throw when package.json is temporarily incomplete during watch mode', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      mkdirSync(sourceDirectory)
      mkdirSync(generatedDirectory)
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(path.join(generatedDirectory, 'my_addon.darwin-arm64.node'), 'native')

      const plugin = rolldownPlugin({ cwd: projectDir, build: false })
      const context = {
        addWatchFile() {},
        emitFile() {
          return 'asset'
        },
      }
      await Reflect.apply(plugin.buildStart!, context, [])
      writeFileSync(path.join(projectDir, 'package.json'), '{')

      expect(() => plugin.watchChange!(path.join(projectDir, 'package.json'))).not.toThrow()
    })
  })

  it('emits only exact target-qualified binaries while leaving JavaScript to the bundler', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
      const sourceDirectory = path.join(projectDir, 'src')
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      mkdirSync(sourceDirectory)
      mkdirSync(generatedDirectory)
      mkdirSync(path.join(generatedDirectory, 'linux-x64'))
      writeFileSync(path.join(sourceDirectory, 'native.swift'), '')
      writeFileSync(path.join(generatedDirectory, 'index.mjs'), 'export const ignored = true')
      writeFileSync(path.join(generatedDirectory, 'my_addon.darwin-arm64.node'), 'darwin')
      writeFileSync(path.join(generatedDirectory, 'linux-x64', 'my_addon.linux-x64.node'), 'linux')
      writeFileSync(path.join(generatedDirectory, 'linux-x64', 'libswiftCore.so.6'), 'swift')
      writeFileSync(path.join(generatedDirectory, 'unrelated.darwin-arm64.node'), 'unrelated')

      const plugin = rolldownPlugin({ cwd: projectDir, build: false })
      const watched: string[] = []
      const emitted: Array<{ fileName: string; source: Buffer }> = []
      await Reflect.apply(
        plugin.buildStart!,
        {
          meta: { watchMode: false },
          addWatchFile(file: string) {
            watched.push(file)
          },
          emitFile(asset: { fileName: string; source: Buffer }) {
            emitted.push(asset)
            return String(emitted.length)
          },
        },
        [],
      )

      expect(emitted.map((asset) => asset.fileName)).toEqual([
        'my_addon.darwin-arm64.node',
        'linux-x64/my_addon.linux-x64.node',
        'linux-x64/libswiftCore.so.6',
      ])
      expect(emitted.map((asset) => asset.source.toString())).toEqual(['darwin', 'linux', 'swift'])
      expect(watched).toContain(path.join(sourceDirectory, 'native.swift'))
      expect(watched).toContain(path.join(generatedDirectory, 'my_addon.darwin-arm64.node'))
      expect(watched).toContain(path.join(generatedDirectory, 'index.mjs'))
    })
  })

  it('lets tsdown bundle the generated runtime while emitting only its native asset', async () => {
    await withProject(async (projectDir) => {
      writeFileSync(
        path.join(projectDir, 'package.json'),
        JSON.stringify({ name: 'my-addon', type: 'module' }),
      )
      const sourceDirectory = path.join(projectDir, 'src')
      const generatedDirectory = path.join(projectDir, 'dist_swift-node')
      mkdirSync(sourceDirectory)
      mkdirSync(generatedDirectory)
      writeFileSync(
        path.join(sourceDirectory, 'index.ts'),
        "export * from '../dist_swift-node/index.mjs'\n",
      )
      writeFileSync(
        path.join(generatedDirectory, 'index.mjs'),
        `import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const native = require(path.join(__dirname, 'my_addon.' + process.platform + '-' + process.arch + '.node'))
export const helloWorld = native.helloWorld
`,
      )
      writeFileSync(
        path.join(generatedDirectory, 'index.d.ts'),
        'export declare const helloWorld: () => string\n',
      )
      writeFileSync(path.join(generatedDirectory, 'my_addon.darwin-arm64.node'), 'darwin')

      await build({
        cwd: projectDir,
        entry: ['src/index.ts'],
        format: ['esm', 'cjs'],
        platform: 'node',
        fixedExtension: false,
        dts: true,
        plugins: [swiftNodeNativeAssets.rolldown({ cwd: projectDir, build: false })],
      })

      expect(existsSync(path.join(projectDir, 'dist', 'my_addon.darwin-arm64.node'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.js'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.d.ts'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist', 'index.d.cts'))).toBe(true)
      expect(existsSync(path.join(projectDir, 'dist_swift-node', 'index.mjs'))).toBe(true)
    })
  })
})
