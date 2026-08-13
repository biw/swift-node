import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createUnplugin } from 'unplugin'
import {
  ensureSwiftNodeBuild,
  findNativeBinaries,
  findSwiftRuntimeLibraries,
  generatedDirectoryName,
  isSwiftNodeBuildInFlight,
  nativeBuildPackageConfiguration,
  nativeAssetFileName,
  swiftWatchFiles,
  type SwiftNodeNativeAssetsOptions,
  invalidateSwiftNodeBuild,
} from './core.js'

export type { SwiftNodeNativeAssetsOptions } from './core.js'

function isSwiftBuildInput(projectDir: string, id: string): boolean {
  const relative = path.relative(projectDir, path.resolve(projectDir, id))
  return relative.startsWith(`src${path.sep}`) && relative.endsWith('.swift')
}

function isGeneratedNativeOutput(
  projectDir: string,
  generatedOutputDirectory: string,
  id: string,
): boolean {
  const relative = path.relative(generatedOutputDirectory, path.resolve(projectDir, id))
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

function tryNativeBuildPackageConfiguration(projectDir: string): string | undefined {
  try {
    return nativeBuildPackageConfiguration(projectDir)
  } catch {
    // Editors can emit a watch event while package.json is only partially
    // written. Treat that state as dirty and let the following stable build
    // surface the normal package validation error if it remains invalid.
    return undefined
  }
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
  let packageConfiguration: string | undefined
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
      packageConfiguration = nativeBuildPackageConfiguration(projectDir)

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

      if (!isEsbuild) {
        for (const output of [
          path.join(generatedOutputDirectory, '.swift-node-build.json'),
          path.join(generatedOutputDirectory, 'index.d.ts'),
          path.join(generatedOutputDirectory, 'index.d.cts'),
          path.join(generatedOutputDirectory, 'index.d.mts'),
          path.join(generatedOutputDirectory, 'index.mjs'),
          path.join(generatedOutputDirectory, 'index.cjs'),
        ]) {
          this.addWatchFile(output)
        }
      }
    },

    watchChange(id) {
      const packageChanged = path.resolve(projectDir, id) === path.join(projectDir, 'package.json')
      const nextPackageConfiguration = packageChanged
        ? tryNativeBuildPackageConfiguration(projectDir)
        : packageConfiguration
      const packageConfigurationChanged =
        packageChanged && nextPackageConfiguration !== packageConfiguration
      const generatedNativeOutputChanged = isGeneratedNativeOutput(
        projectDir,
        generatedOutputDirectory,
        id,
      )
      if (
        isSwiftBuildInput(projectDir, id) ||
        packageConfigurationChanged ||
        // swift-node itself writes these files during an active CLI invocation.
        // Ignore those self-notifications; a changed Swift/package input marks
        // the in-flight run dirty and the core starts exactly one replacement.
        (generatedNativeOutputChanged && !isSwiftNodeBuildInFlight(projectDir))
      ) {
        needsSwiftBuild = true
        invalidateSwiftNodeBuild(projectDir)
      }
      if (packageChanged) packageConfiguration = nextPackageConfiguration
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
