import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createUnplugin } from 'unplugin'
import {
  ensureSwiftNodeBuild,
  findNativeBinaries,
  findSwiftRuntimeLibraries,
  generatedDirectoryName,
  nativeAssetFileName,
  swiftWatchFiles,
  type SwiftNodeNativeAssetsOptions,
  invalidateSwiftNodeBuild,
} from './core.js'

export type { SwiftNodeNativeAssetsOptions } from './core.js'

function isSwiftBuildInput(projectDir: string, id: string): boolean {
  const relative = path.relative(projectDir, id)
  return (
    relative === 'package.json' ||
    (relative.startsWith(`src${path.sep}`) && relative.endsWith('.swift'))
  )
}

/**
 * Compiles Swift before a bundle starts, then emits only the generated
 * target-qualified native binaries. JavaScript stays in the bundler's graph so
 * tsdown (or another host) can optimize it normally.
 */
export const swiftNodeNativeAssets = /* #__PURE__ */ createUnplugin<
  SwiftNodeNativeAssetsOptions | undefined
>((options, meta) => {
  const config = options ?? {}
  const projectDir = path.resolve(config.cwd ?? process.cwd())
  const generatedDirectory = config.generatedDirectory ?? generatedDirectoryName
  const generatedOutputDirectory = path.resolve(projectDir, generatedDirectory)
  const assetDirectory = config.assetDirectory
  const isEsbuild = meta.framework === 'esbuild'
  let needsSwiftBuild = true
  let esbuildOutput: { absWorkingDir?: string; outdir?: string; outfile?: string } | undefined

  function emitEsbuildOutfileAsset(binaryPath: string): void {
    const relativeOutfile = esbuildOutput?.outfile
    const outfile = relativeOutfile
      ? path.resolve(esbuildOutput?.absWorkingDir ?? process.cwd(), relativeOutfile)
      : undefined
    if (!outfile) return
    const destination = path.join(
      path.dirname(outfile),
      // An outfile already defines the runtime directory. Do not apply
      // assetDirectory a second time or the resolver and sidecar diverge.
      nativeAssetFileName(binaryPath, undefined, generatedOutputDirectory),
    )
    const destinationDirectory = path.dirname(destination)
    mkdirSync(destinationDirectory, { recursive: true })
    copyFileSync(binaryPath, destination)
  }

  return {
    name: 'swift-node-native-assets',

    async buildStart() {
      if (config.build !== false && needsSwiftBuild) {
        await ensureSwiftNodeBuild(projectDir)
      }
      needsSwiftBuild = false

      // Unplugin's esbuild adapter only accepts watch files from resolve/load/
      // transform hooks. Its one-shot adapter still builds and emits correctly;
      // the other hosts receive their normal Swift-source watches here.
      if (!isEsbuild) {
        for (const sourcePath of swiftWatchFiles(projectDir)) {
          this.addWatchFile(sourcePath)
        }
      }

      const nativeAssets = [
        ...findNativeBinaries(projectDir, generatedDirectory),
        ...findSwiftRuntimeLibraries(projectDir, generatedDirectory),
      ]
      for (const binaryPath of nativeAssets) {
        if (!isEsbuild) this.addWatchFile(binaryPath)
        if (isEsbuild && esbuildOutput?.outfile) {
          emitEsbuildOutfileAsset(binaryPath)
        } else {
          if (isEsbuild && !esbuildOutput?.outdir) {
            throw new Error('swiftNodeNativeAssets.esbuild requires esbuild outdir or outfile.')
          }
          this.emitFile({
            type: 'asset',
            fileName: nativeAssetFileName(binaryPath, assetDirectory, generatedOutputDirectory),
            source: readFileSync(binaryPath),
          })
        }
      }
    },

    watchChange(id) {
      if (isSwiftBuildInput(projectDir, id)) {
        needsSwiftBuild = true
        invalidateSwiftNodeBuild(projectDir)
      }
    },

    vite: {
      // Vite does not emit Rollup assets for SSR by default. This plugin is for
      // Node outputs, so retain the native sidecar for both server and library
      // builds.
      config() {
        return { build: { emitAssets: true, ssrEmitAssets: true } }
      },
    },

    esbuild: {
      setup(build) {
        esbuildOutput = {
          absWorkingDir: build.initialOptions.absWorkingDir,
          outdir: build.initialOptions.outdir,
          outfile: build.initialOptions.outfile,
        }
      },
    },
  }
})
