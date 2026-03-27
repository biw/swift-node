import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build as esbuildBuild } from 'esbuild'
import { rollup } from 'rollup'
import { build as viteBuild } from 'vite'
import webpack from 'webpack'
import { describe, expect, it } from 'vite-plus/test'
import esbuildPlugin from '../src/esbuild'
import rolldownPlugin from '../src/rolldown'
import rollupPlugin from '../src/rollup'
import vitePlugin from '../src/vite'
import webpackPlugin from '../src/webpack'

const moduleName = 'my_addon'
const nativeFilename = `${moduleName}.darwin-arm64.node`
const runtimeFilename = 'libswiftCore.so.6'

function withProject(callback: (projectDir: string) => Promise<void>): Promise<void> {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-unplugin-adapters-'))
  const sourceDirectory = path.join(projectDir, 'src')
  const generatedDirectory = path.join(projectDir, 'dist_swift-node')
  const targetDirectory = path.join(generatedDirectory, 'darwin-arm64')
  mkdirSync(sourceDirectory)
  mkdirSync(targetDirectory, { recursive: true })
  writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ name: 'my-addon' }))
  writeFileSync(path.join(sourceDirectory, 'index.js'), 'export const hello = "world"\n')
  writeFileSync(path.join(targetDirectory, nativeFilename), 'native')
  // Linux-style sidecar keeps this adapter test platform independent; real
  // Windows builds use .dll instead.
  writeFileSync(path.join(targetDirectory, runtimeFilename), 'swift runtime')

  return callback(projectDir).finally(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })
}

function expectAssets(outputDirectory: string): void {
  expect(existsSync(path.join(outputDirectory, 'server', 'darwin-arm64', nativeFilename))).toBe(
    true,
  )
  expect(existsSync(path.join(outputDirectory, 'server', 'darwin-arm64', runtimeFilename))).toBe(
    true,
  )
}

describe('public Unplugin adapters', () => {
  it('exposes conventional default factories for every advertised adapter', () => {
    expect(vitePlugin).toBeTypeOf('function')
    expect(rollupPlugin).toBeTypeOf('function')
    expect(rolldownPlugin).toBeTypeOf('function')
    expect(webpackPlugin).toBeTypeOf('function')
    expect(esbuildPlugin).toBeTypeOf('function')
  })

  it('emits native and Swift-runtime sidecars with Rollup', async () => {
    await withProject(async (projectDir) => {
      const outputDirectory = path.join(projectDir, 'dist')
      const bundle = await rollup({
        input: path.join(projectDir, 'src', 'index.js'),
        plugins: [rollupPlugin({ cwd: projectDir, build: false, assetDirectory: 'server' })],
      })
      await bundle.write({
        dir: outputDirectory,
        entryFileNames: 'server/index.mjs',
        format: 'es',
      })
      await bundle.close()

      expectAssets(outputDirectory)
    })
  })

  it('emits native and Swift-runtime sidecars with Vite SSR', async () => {
    await withProject(async (projectDir) => {
      const outputDirectory = path.join(projectDir, 'dist')
      await viteBuild({
        configFile: false,
        root: projectDir,
        plugins: [vitePlugin({ cwd: projectDir, build: false, assetDirectory: 'server' })],
        build: {
          emptyOutDir: true,
          outDir: outputDirectory,
          rollupOptions: { output: { entryFileNames: 'server/index.mjs' } },
          ssr: path.join(projectDir, 'src', 'index.js'),
        },
      })

      expectAssets(outputDirectory)
    })
  })

  it('emits native and Swift-runtime sidecars with webpack', async () => {
    await withProject(
      (projectDir) =>
        new Promise<void>((resolve, reject) => {
          const outputDirectory = path.join(projectDir, 'dist')
          webpack(
            {
              entry: path.join(projectDir, 'src', 'index.js'),
              mode: 'production',
              output: {
                clean: true,
                filename: 'server/index.cjs',
                path: outputDirectory,
              },
              plugins: [webpackPlugin({ cwd: projectDir, build: false, assetDirectory: 'server' })],
              target: 'node',
            },
            (error, stats) => {
              if (error) return reject(error)
              if (stats?.hasErrors())
                return reject(new Error(stats.toString({ all: false, errors: true })))
              expectAssets(outputDirectory)
              resolve()
            },
          )
        }),
    )
  })

  it('emits native and Swift-runtime sidecars with esbuild', async () => {
    await withProject(async (projectDir) => {
      const outputDirectory = path.join(projectDir, 'dist')
      await esbuildBuild({
        bundle: true,
        entryNames: 'server/[name]',
        entryPoints: [path.join(projectDir, 'src', 'index.js')],
        format: 'esm',
        outdir: outputDirectory,
        plugins: [esbuildPlugin({ cwd: projectDir, build: false, assetDirectory: 'server' })],
        platform: 'node',
      })

      expectAssets(outputDirectory)
    })
  })

  it('places sidecars beside a relative esbuild outfile using absWorkingDir', async () => {
    await withProject(async (projectDir) => {
      const outputDirectory = path.join(projectDir, 'dist', 'server')
      await esbuildBuild({
        absWorkingDir: projectDir,
        bundle: true,
        entryPoints: ['src/index.js'],
        format: 'esm',
        outfile: 'dist/server/index.mjs',
        plugins: [esbuildPlugin({ cwd: projectDir, build: false, assetDirectory: 'server' })],
        platform: 'node',
      })

      expect(existsSync(path.join(outputDirectory, 'darwin-arm64', nativeFilename))).toBe(true)
      expect(existsSync(path.join(outputDirectory, 'darwin-arm64', runtimeFilename))).toBe(true)
    })
  })
})
