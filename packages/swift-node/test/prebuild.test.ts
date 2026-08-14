import { describe, expect, it } from 'vite-plus/test'
import { readFileSync } from 'node:fs'
import {
  generatePrebuildCiWorkflow,
  generatePrebuildWorkflow,
  nativeTargetId,
  packageFilesForPrebuildTargets,
  prebuildFilename,
  selectPrebuildTargets,
  supportedPrebuildTargets,
} from '../src/prebuild'

describe('prebuild targets', () => {
  it('uses Node platform and architecture spellings in the filename', () => {
    expect(prebuildFilename('my_addon', 'darwin', 'arm64')).toBe('my_addon.darwin-arm64.node')
    expect(prebuildFilename('my_addon', 'win32', 'x64')).toBe('my_addon.win32-x64.node')
  })

  it('keeps a local musl build separate from a glibc target', () => {
    expect(nativeTargetId('linux', 'x64', false)).toBe('linux-x64')
    expect(nativeTargetId('linux', 'x64', true)).toBe('linux-x64-musl')
    expect(prebuildFilename('my_addon', 'linux', 'x64')).toBe(
      `my_addon.${nativeTargetId('linux', 'x64')}.node`,
    )
  })

  it('offers the six GitHub-hosted runner targets', () => {
    expect(supportedPrebuildTargets).toEqual([
      expect.objectContaining({ id: 'linux-x64', runner: 'ubuntu-22.04' }),
      expect.objectContaining({ id: 'win32-x64', runner: 'windows-2022' }),
      expect.objectContaining({ id: 'linux-arm64', runner: 'ubuntu-22.04-arm', preview: true }),
      expect.objectContaining({ id: 'win32-arm64', runner: 'windows-11-arm', preview: true }),
      expect.objectContaining({ id: 'darwin-x64', runner: 'macos-26-intel' }),
      expect.objectContaining({ id: 'darwin-arm64', runner: 'macos-26' }),
    ])
  })

  it('keeps selected targets in the canonical prompt order', () => {
    expect(selectPrebuildTargets(['darwin-arm64', 'linux-x64']).map((target) => target.id)).toEqual(
      ['linux-x64', 'darwin-arm64'],
    )
  })

  it('does not publish a local binary alongside target-qualified binaries', () => {
    expect(packageFilesForPrebuildTargets([])).toEqual(['dist_swift-node/', 'src/'])
    expect(packageFilesForPrebuildTargets(selectPrebuildTargets(['linux-x64']))).toEqual([
      'dist_swift-node/index.cjs',
      'dist_swift-node/index.mjs',
      'dist_swift-node/index.d.ts',
      'dist_swift-node/index.d.cts',
      'dist_swift-node/index.d.mts',
      'dist_swift-node/linux-x64/*.linux-x64.node',
      'dist_swift-node/*/*.so*',
      'src/',
    ])
    expect(
      packageFilesForPrebuildTargets(selectPrebuildTargets(['linux-x64', 'win32-x64'])),
    ).toContain('dist_swift-node/*/*.dll')
    expect(packageFilesForPrebuildTargets(selectPrebuildTargets(['darwin-arm64']))).toContain(
      'dist_swift-node/*.darwin-arm64.node',
    )
    expect(
      packageFilesForPrebuildTargets(selectPrebuildTargets(['linux-x64']), {
        shipSwiftRuntime: false,
      }),
    ).not.toContain('dist_swift-node/*/*.so*')
    expect(packageFilesForPrebuildTargets([], { bundleWithTsdown: true })).toEqual([
      'dist/',
      'src/',
    ])
  })
})

describe('generated prebuild workflow', () => {
  it('keeps the copyable all-platform template in sync with the generator', () => {
    const template = readFileSync(
      new URL('../templates/prebuild.yml', import.meta.url),
      'utf-8',
    ).replace(/\r\n/g, '\n')
    const generated = generatePrebuildWorkflow(supportedPrebuildTargets, {
      moduleName: 'your_addon',
      publishToNpm: true,
    })

    expect(template).toBe(generated)
  })

  it('publishes selected targets only after successful CI on the current main revision', () => {
    const workflow = generatePrebuildWorkflow(selectPrebuildTargets(['linux-x64', 'win32-arm64']), {
      moduleName: 'my_addon',
    })

    expect(workflow).toContain('name: Publish to npm')
    expect(workflow).toContain('  workflow_run:')
    expect(workflow).toContain('    workflows: [CI]')
    expect(workflow).toContain('  group: npm-publish')
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(workflow).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(workflow).toContain('TESTED_SHA: ${{ github.event.workflow_run.head_sha }}')
    expect(workflow).toContain('PACKAGE_NAME=$(node -p "require(\'./package.json\').name")')
    expect(workflow).toContain('target: linux-x64')
    expect(workflow).toContain('runner: ubuntu-22.04')
    expect(workflow).toContain('target: win32-arm64')
    expect(workflow).toContain('runner: windows-11-arm')
    expect(workflow).toContain('uses: actions/setup-node@v7')
    expect(workflow).toContain('uses: actions/upload-artifact@v7')
    expect(workflow).toContain('uses: actions/download-artifact@v8')
    expect(workflow).toContain('SwiftyLab/setup-swift@38f54a76b70d989321de9dc7c840618c08cf56e9')
    expect(workflow).toContain('prebuild_path: dist_swift-node/linux-x64/**')
    expect(workflow).toContain('name: swift-node-runtime-files')
    expect(workflow).toContain('            dist_swift-node/index.mjs')
    expect(workflow).toContain('    needs: check-version')
    expect(workflow).toContain('  publish:')
    expect(workflow).toContain('    needs: [check-version, build]')
    expect(workflow).toContain('          pattern: swift-node-prebuild-*')
    expect(workflow).toContain('          path: .swift-node-prebuild-artifacts')
    expect(workflow).not.toContain('merge-multiple: true')
    expect(workflow).toContain(
      'source=".swift-node-prebuild-artifacts/swift-node-prebuild-$target"',
    )
    expect(workflow).toContain('destination="$OUTPUT_DIRECTORY/$target"')
    expect(workflow).toContain('          MODULE_NAME: my_addon')
    expect(workflow).toContain('test -f "dist_swift-node/$target/$MODULE_NAME.$target.node"')
    expect(workflow).toContain('name: Build native addon and target binary')
    expect(workflow).toContain('npm run build')
    expect(workflow).not.toContain('swift-node prebuild')
    expect(workflow).toContain('npm pack --pack-destination release')
    expect(workflow).not.toContain('workflow_dispatch:')
    expect(workflow).not.toContain("tags: ['v*']")
    expect(workflow).not.toContain('npm publish')
    expect(workflow).not.toContain('npx swift-node')
    expect(workflow).not.toContain('\n  pull_request:')
  })

  it.each([
    ['pnpm', 'pnpm install --frozen-lockfile', 'pnpm run build'],
    ['yarn', 'yarn install --immutable', 'yarn run build'],
    ['bun', 'bun install --frozen-lockfile', 'bun run build'],
  ] as const)(
    'uses the selected package manager to install and build for %s',
    (packageManager, install, build) => {
      const workflow = generatePrebuildWorkflow(selectPrebuildTargets(['linux-x64']), {
        packageManager,
        packageManagerVersion: '1.2.3',
      })

      expect(workflow).toContain(`run: ${install}`)
      expect(workflow).toContain(`run: ${build}`)
      expect(workflow).not.toContain('swift-node prebuild')
      expect(workflow).toContain('npm pack --pack-destination release')
      expect(workflow).not.toContain('npx swift-node')
      if (packageManager === 'bun') {
        expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6')
      }
    },
  )

  it.each(['npm', 'pnpm', 'yarn', 'bun'] as const)(
    'publishes an assembled package with npm trusted publishing after %s builds it',
    (packageManager) => {
      const workflow = generatePrebuildWorkflow(selectPrebuildTargets(['linux-x64']), {
        packageManager,
        moduleName: 'my_addon',
        publishToNpm: true,
      })

      expect(workflow).toContain('  id-token: write')
      expect(workflow).toContain("if: needs.check-version.outputs.should-publish == 'true'")
      expect(workflow).toContain('Verify npm supports trusted publishing')
      expect(workflow).toContain('Refusing to publish a revision that is no longer the tip of main')
      expect(workflow).toContain('npm publish release/*.tgz')
      expect(workflow).toContain('uses: softprops/action-gh-release@v3')
      expect(workflow).toContain('target_commitish: ${{ github.event.workflow_run.head_sha }}')
    },
  )

  it('rejects an empty workflow matrix', () => {
    expect(() => generatePrebuildWorkflow([])).toThrow('At least one prebuild target')
  })

  it('assembles tsdown output and target-qualified native assets into dist', () => {
    const workflow = generatePrebuildWorkflow(selectPrebuildTargets(['linux-x64']), {
      moduleName: 'my_addon',
      bundleWithTsdown: true,
    })

    expect(workflow).toContain('prebuild_path: dist/linux-x64/**')
    expect(workflow).toContain('            dist/**')
    expect(workflow).toContain('            !dist/**/*.node')
    expect(workflow).toContain('            !dist/**/*.so*')
    expect(workflow).toContain('            !dist/**/*.dll')
    expect(workflow).toContain('path: dist/')
    expect(workflow).toContain('test -f "dist/$target/$MODULE_NAME.$target.node"')
  })

  it('places macOS target-qualified binaries beside the generated runtime', () => {
    const workflow = generatePrebuildWorkflow(selectPrebuildTargets(['darwin-arm64']), {
      moduleName: 'my_addon',
      bundleWithTsdown: true,
    })

    expect(workflow).toContain('prebuild_path: dist/my_addon.darwin-arm64.node')
    expect(workflow).toContain('case "$target" in')
    expect(workflow).toContain('cp "$source/$binary" "$OUTPUT_DIRECTORY/$binary"')
    expect(workflow).toContain('test -f "dist/$MODULE_NAME.$target.node"')
  })
})

describe('generated prebuild CI workflow', () => {
  it('runs the selected package manager build on each target', () => {
    const workflow = generatePrebuildCiWorkflow(
      selectPrebuildTargets(['linux-x64', 'darwin-arm64']),
      { packageManager: 'pnpm' },
    )

    expect(workflow).toContain('name: CI')
    expect(workflow).toContain('runner: ubuntu-22.04')
    expect(workflow).toContain('runner: macos-26')
    expect(workflow).toContain('uses: actions/setup-node@v7')
    expect(workflow).toContain('node-version: 24')
    expect(workflow).toContain('swift-version: 6.3.3')
    expect(workflow).toContain('pnpm install --frozen-lockfile')
    expect(workflow).toContain('pnpm run build')
    expect(workflow).not.toContain('swift-node prebuild')
  })

  it('rejects an empty CI matrix', () => {
    expect(() => generatePrebuildCiWorkflow([])).toThrow('At least one prebuild target')
  })
})
