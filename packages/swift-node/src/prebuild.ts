import path from 'node:path'

export interface PrebuildTarget {
  /** Node's platform-architecture identifier, for example `darwin-arm64`. */
  id: string
  label: string
  platform: NodeJS.Platform
  arch: string
  runner: string
  preview?: boolean
}

export type PrebuildPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface PrebuildWorkflowOptions {
  /** The package manager selected during `swift-node init`. */
  packageManager?: PrebuildPackageManager
  packageManagerVersion?: string
  /** The module name emitted by `swift-node build` (not necessarily the npm name). */
  moduleName?: string
  /** Publish the assembled package after successful CI on main. */
  publishToNpm?: boolean
  /** The package bundles JavaScript with tsdown and emits native assets into dist/. */
  bundleWithTsdown?: boolean
  /** Ship the Swift dynamic runtime beside Linux and Windows target binaries. */
  shipSwiftRuntime?: boolean
}

const swiftToolchainVersion = '6.3.3'

/**
 * The native platforms swift-node supports in generated GitHub Actions
 * workflows. IDs intentionally use Node's `process.platform`/`process.arch`
 * spelling because they are also embedded in the prebuilt binary filename.
 */
export const supportedPrebuildTargets: readonly PrebuildTarget[] = [
  {
    id: 'linux-x64',
    label: 'Linux x64 (glibc, Intel/AMD)',
    platform: 'linux',
    arch: 'x64',
    // Build against Ubuntu 22.04's glibc baseline. Alpine/musl is intentionally
    // not selected by this target-qualified filename.
    runner: 'ubuntu-22.04',
  },
  {
    id: 'win32-x64',
    label: 'Windows x64 (Intel/AMD)',
    platform: 'win32',
    arch: 'x64',
    runner: 'windows-2022',
  },
  {
    id: 'linux-arm64',
    label: 'Linux ARM64 (glibc)',
    platform: 'linux',
    arch: 'arm64',
    runner: 'ubuntu-22.04-arm',
    preview: true,
  },
  {
    id: 'win32-arm64',
    label: 'Windows ARM64',
    platform: 'win32',
    arch: 'arm64',
    runner: 'windows-11-arm',
    preview: true,
  },
  {
    id: 'darwin-x64',
    label: 'macOS Intel',
    platform: 'darwin',
    arch: 'x64',
    runner: 'macos-15-intel',
  },
  {
    id: 'darwin-arm64',
    label: 'macOS ARM64',
    platform: 'darwin',
    arch: 'arm64',
    runner: 'macos-15',
  },
]

function currentLinuxUsesMusl(): boolean {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  return !report?.header?.glibcVersionRuntime
}

/**
 * Node reports glibc at runtime but does not expose an equivalent musl name.
 * Keep local musl builds in a separate directory so a package containing a
 * glibc prebuild cannot be mistaken for one built against musl.
 */
export function nativeTargetId(
  platform = process.platform,
  arch = process.arch,
  musl = platform === process.platform &&
    arch === process.arch &&
    platform === 'linux' &&
    currentLinuxUsesMusl(),
): string {
  return `${platform}-${arch}${musl ? '-musl' : ''}`
}

export function prebuildFilename(
  moduleName: string,
  platform = process.platform,
  arch = process.arch,
): string {
  return `${moduleName}.${nativeTargetId(platform, arch)}.node`
}

export function selectPrebuildTargets(ids: readonly string[]): PrebuildTarget[] {
  const selected = new Set(ids)
  return supportedPrebuildTargets.filter((target) => selected.has(target.id))
}

const generatedRuntimeFiles = [
  'dist_swift-node/index.cjs',
  'dist_swift-node/index.mjs',
  'dist_swift-node/index.d.ts',
  'dist_swift-node/index.d.cts',
  'dist_swift-node/index.d.mts',
] as const

/**
 * Local-only packages can publish their dist_swift-node/ directory,
 * including the host binary. Packages with target-qualified binaries publish only
 * platform-independent runtime files and explicitly qualified native files, so
 * they never ship an assembly-machine binary by accident.
 */
export function packageFilesForPrebuildTargets(
  targets: readonly PrebuildTarget[],
  options: Pick<PrebuildWorkflowOptions, 'bundleWithTsdown' | 'shipSwiftRuntime'> = {},
): string[] {
  if (options.bundleWithTsdown) return ['dist/', 'src/']

  const shipSwiftRuntime = options.shipSwiftRuntime ?? true

  return [
    ...(targets.length === 0
      ? ['dist_swift-node/']
      : [
          ...generatedRuntimeFiles,
          ...targets.map((target) => `dist_swift-node/${target.id}/*.${target.id}.node`),
          ...(shipSwiftRuntime && targets.some((target) => target.platform === 'linux')
            ? ['dist_swift-node/*/*.so*']
            : []),
          ...(shipSwiftRuntime && targets.some((target) => target.platform === 'win32')
            ? ['dist_swift-node/*/*.dll']
            : []),
        ]),
    'src/',
  ]
}

interface PackageManagerWorkflowCommands {
  setup: string[]
  install: string
  run: (script: string) => string
}

/**
 * Generate the CI workflow that gates the generated publish workflow. It runs
 * the ordinary package build on every selected native target, so an artifact
 * is never published before the same source has compiled successfully there.
 */
export function generatePrebuildCiWorkflow(
  targets: readonly PrebuildTarget[],
  options: Pick<PrebuildWorkflowOptions, 'packageManager' | 'packageManagerVersion'> = {},
): string {
  if (targets.length === 0) {
    throw new Error('At least one prebuild target is required to generate a CI workflow.')
  }

  const commands = packageManagerWorkflowCommands(
    options.packageManager ?? 'npm',
    options.packageManagerVersion,
  )
  const matrix = targets.flatMap((target) => [
    `          - label: ${target.label}`,
    `            runner: ${target.runner}`,
  ])

  return [
    '# Generated by swift-node init. The publish workflow runs only after this',
    '# workflow succeeds on the current tip of main.',
    'name: CI',
    '',
    'on:',
    '  push:',
    '    branches: [main]',
    '  pull_request:',
    '    branches: [main]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  build:',
    '    name: ${{ matrix.label }}',
    '    runs-on: ${{ matrix.runner }}',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        include:',
    ...matrix,
    '',
    '    steps:',
    '      - uses: actions/checkout@v7',
    '',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '',
    ...commands.setup,
    ...(commands.setup.length > 0 ? [''] : []),
    '      - uses: SwiftyLab/setup-swift@38f54a76b70d989321de9dc7c840618c08cf56e9 # v1.14.0',
    '        with:',
    `          swift-version: ${swiftToolchainVersion}`,
    '',
    '      - name: Install dependencies',
    `        run: ${commands.install}`,
    '',
    '      - name: Build package',
    `        run: ${commands.run('build')}`,
    '',
  ].join('\n')
}

function packageManagerWorkflowCommands(
  packageManager: PrebuildPackageManager,
  packageManagerVersion?: string,
): PackageManagerWorkflowCommands {
  switch (packageManager) {
    case 'pnpm':
      return {
        setup: ['      - name: Enable Corepack', '        run: corepack enable'],
        install: 'pnpm install --frozen-lockfile',
        run: (script) => `pnpm run ${script}`,
      }
    case 'yarn':
      return {
        setup: ['      - name: Enable Corepack', '        run: corepack enable'],
        install: 'yarn install --immutable',
        run: (script) => `yarn run ${script}`,
      }
    case 'bun':
      return {
        setup: [
          `      - uses: oven-sh/setup-bun@ecf28ddc73e819eb6fa29df6b34ef8921c743461 # v2.1.3`,
          '        with:',
          `          bun-version: ${packageManagerVersion ?? 'latest'}`,
        ],
        install: 'bun install --frozen-lockfile',
        run: (script) => `bun run ${script}`,
      }
    case 'npm':
      return {
        setup: [],
        install: 'npm ci',
        run: (script) => `npm run ${script}`,
      }
  }
}

/**
 * Produce a CI-gated build, assembly, and optional npm publication workflow.
 *
 * The release safety and check-version jobs deliberately follow the project
 * publish template. The matrix is the one necessary addition: a Linux runner
 * cannot produce native macOS or Windows binaries.
 */
export function generatePrebuildWorkflow(
  targets: readonly PrebuildTarget[],
  options: PrebuildWorkflowOptions = {},
): string {
  if (targets.length === 0) {
    throw new Error('At least one prebuild target is required to generate a workflow.')
  }

  const packageManager = options.packageManager ?? 'npm'
  const commands = packageManagerWorkflowCommands(packageManager, options.packageManagerVersion)
  const moduleName = options.moduleName ?? 'native_addon'
  const publishToNpm = options.publishToNpm ?? false
  const bundleWithTsdown = options.bundleWithTsdown ?? false
  const outputDirectory = bundleWithTsdown ? 'dist' : 'dist_swift-node'
  const runtimeArtifactPaths = bundleWithTsdown
    ? [
        '            dist/**',
        '            !dist/**/*.node',
        '            !dist/**/*.so*',
        '            !dist/**/*.dll',
      ]
    : generatedRuntimeFiles.map((file) => `            ${file}`)
  const runtimeFilesToVerify = bundleWithTsdown
    ? ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']
    : generatedRuntimeFiles.map((file) => path.basename(file))

  const matrix = targets.flatMap((target, index) => [
    `          - target: ${target.id}`,
    `            label: ${target.label}`,
    `            runner: ${target.runner}`,
    `            generated_sources: ${index === 0}`,
  ])
  const prebuildArtifactPaths = [`            ${outputDirectory}/\${{ matrix.target }}/**`]

  return [
    '# Generated by swift-node init. This runs only after the CI workflow named',
    '# CI succeeds on the current tip of main. Matrix workers build one binary',
    '# each, then a Linux job assembles all binaries into one npm package.',
    '# Linux and Windows ARM64 runners are currently GitHub Actions public preview.',
    'name: Publish to npm',
    '',
    'on:',
    '  workflow_run:',
    '    workflows: [CI]',
    '    types: [completed]',
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    '  group: npm-publish',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  check-version:',
    '    if: >-',
    "      github.event.workflow_run.conclusion == 'success' &&",
    "      github.event.workflow_run.event == 'push' &&",
    "      github.event.workflow_run.head_branch == 'main' &&",
    '      github.event.workflow_run.head_repository.full_name == github.repository',
    '    runs-on: ubuntu-latest',
    '    outputs:',
    '      version: ${{ steps.check.outputs.version }}',
    '      should-publish: ${{ steps.check.outputs.should_publish }}',
    '    steps:',
    '      - name: Checkout the CI-tested revision',
    '        uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    '          ref: ${{ github.event.workflow_run.head_sha }}',
    '',
    '      - name: Verify the tested revision is still main',
    '        id: revision',
    '        env:',
    '          TESTED_SHA: ${{ github.event.workflow_run.head_sha }}',
    '        run: |',
    '          if [ "$(git rev-parse HEAD)" != "$TESTED_SHA" ]; then',
    '            echo "Checked out revision does not match the successful CI run" >&2',
    '            exit 1',
    '          fi',
    '',
    '          git fetch --no-tags origin main',
    '',
    '          if [ "$(git rev-parse origin/main)" != "$TESTED_SHA" ]; then',
    '            echo "is_current=false" >> "$GITHUB_OUTPUT"',
    '            echo "Skipping stale successful CI revision $TESTED_SHA"',
    '            exit 0',
    '          fi',
    '          echo "is_current=true" >> "$GITHUB_OUTPUT"',
    '',
    '      - name: Setup Node.js',
    "        if: steps.revision.outputs.is_current == 'true'",
    '        uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '',
    '      - name: Check if version should be published',
    "        if: steps.revision.outputs.is_current == 'true'",
    '        id: check',
    '        run: |',
    '          npm ping --registry=https://registry.npmjs.org',
    '',
    '          CURRENT_VERSION=$(node -p "require(\'./package.json\').version")',
    '          PACKAGE_NAME=$(node -p "require(\'./package.json\').name")',
    '          echo "version=$CURRENT_VERSION" >> "$GITHUB_OUTPUT"',
    '          echo "Current package: $PACKAGE_NAME@$CURRENT_VERSION"',
    '',
    '          npm view "$PACKAGE_NAME" versions --json > published-versions.json 2>/dev/null || echo "[]" > published-versions.json',
    '',
    '          if node -e "',
    "            const versions = require('./published-versions.json')",
    '            const list = Array.isArray(versions) ? versions : [versions]',
    '            process.exit(list.includes(process.argv[1]) ? 0 : 1)',
    '          " "$CURRENT_VERSION"; then',
    '            echo "Version $CURRENT_VERSION is already published"',
    '            echo "should_publish=false" >> "$GITHUB_OUTPUT"',
    '          else',
    '            echo "Version $CURRENT_VERSION has not been published"',
    '            echo "should_publish=true" >> "$GITHUB_OUTPUT"',
    '          fi',
    '',
    '  build:',
    '    needs: check-version',
    "    if: needs.check-version.outputs.should-publish == 'true'",
    '    name: ${{ matrix.label }}',
    '    runs-on: ${{ matrix.runner }}',
    '    strategy:',
    '      fail-fast: false',
    '      matrix:',
    '        include:',
    ...matrix,
    '',
    '    steps:',
    '      - name: Checkout the CI-tested revision',
    '        uses: actions/checkout@v7',
    '        with:',
    '          ref: ${{ github.event.workflow_run.head_sha }}',
    '',
    '      - uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    '',
    ...commands.setup,
    ...(commands.setup.length > 0 ? [''] : []),
    '      # Keep the prebuild ABI reproducible across every target.',
    '      - uses: SwiftyLab/setup-swift@38f54a76b70d989321de9dc7c840618c08cf56e9 # v1.14.0',
    '        with:',
    `          swift-version: ${swiftToolchainVersion}`,
    '',
    '      - name: Install dependencies',
    `        run: ${commands.install}`,
    '',
    '      - name: Build native addon and target binary',
    `        run: ${commands.run('build')}`,
    '',
    '      - name: Upload prebuild',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: swift-node-prebuild-${{ matrix.target }}',
    '          path: |',
    ...prebuildArtifactPaths,
    '          if-no-files-found: error',
    '          retention-days: 7',
    '',
    '      # Runtime JavaScript and declarations are platform-independent, so',
    '      # upload them exactly once and use them in the publish job below.',
    '      - name: Upload generated runtime files',
    '        if: matrix.generated_sources',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: swift-node-runtime-files',
    '          path: |',
    ...runtimeArtifactPaths,
    '          if-no-files-found: error',
    '          retention-days: 7',
    '',
    '  publish:',
    '    needs: [check-version, build]',
    "    if: needs.check-version.outputs.should-publish == 'true'",
    '    runs-on: ubuntu-latest',
    ...(publishToNpm ? ['    permissions:', '      contents: read', '      id-token: write'] : []),
    '    steps:',
    '      - name: Checkout the CI-tested revision',
    '        uses: actions/checkout@v7',
    '        with:',
    '          fetch-depth: 0',
    '          ref: ${{ github.event.workflow_run.head_sha }}',
    '',
    '      - name: Setup Node.js',
    '        uses: actions/setup-node@v7',
    '        with:',
    '          node-version: 24',
    ...(publishToNpm
      ? [
          "          registry-url: 'https://registry.npmjs.org'",
          '          package-manager-cache: false',
        ]
      : []),
    '',
    '      - name: Download generated runtime files',
    '        uses: actions/download-artifact@v4',
    '        with:',
    '          name: swift-node-runtime-files',
    `          path: ${outputDirectory}/`,
    '',
    '      - name: Download target-qualified binaries',
    '        uses: actions/download-artifact@v4',
    '        with:',
    '          pattern: swift-node-prebuild-*',
    '          path: .swift-node-prebuild-artifacts',
    '',
    '      - name: Assemble target directories',
    '        env:',
    `          OUTPUT_DIRECTORY: ${outputDirectory}`,
    `          TARGETS: ${targets.map((target) => target.id).join(' ')}`,
    '        run: |',
    '          for target in $TARGETS; do',
    '            source=".swift-node-prebuild-artifacts/swift-node-prebuild-$target"',
    '            destination="$OUTPUT_DIRECTORY/$target"',
    '            test -d "$source"',
    '            mkdir -p "$destination"',
    '            cp -R "$source/." "$destination/"',
    '          done',
    '',
    '      - name: Verify prebuild set',
    '        env:',
    `          MODULE_NAME: ${moduleName}`,
    `          TARGETS: ${targets.map((target) => target.id).join(' ')}`,
    '        run: |',
    ...runtimeFilesToVerify.map((file) => `          test -f "${outputDirectory}/${file}"`),
    '          for target in $TARGETS; do',
    `            test -f "${outputDirectory}/$target/$MODULE_NAME.$target.node"`,
    '          done',
    '',
    '      - name: Pack release package',
    '        run: mkdir -p release && npm pack --pack-destination release',
    '',
    '      - name: Upload release package',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: swift-node-release-package',
    '          path: release/*.tgz',
    '          if-no-files-found: error',
    '          retention-days: 7',
    ...(publishToNpm
      ? [
          '',
          '      - name: Verify npm supports trusted publishing',
          '        run: |',
          '          NPM_VERSION=$(npm --version)',
          '          echo "npm version: $NPM_VERSION"',
          '',
          '          node -e "',
          "            const version = process.argv[1].split('.').map(Number)",
          '            const minimum = [11, 5, 1]',
          '',
          '            for (let i = 0; i < minimum.length; i++) {',
          '              if (version[i] > minimum[i]) process.exit(0)',
          '              if (version[i] < minimum[i]) process.exit(1)',
          '            }',
          '          " "$NPM_VERSION"',
          '',
          '      - name: Reconfirm the published revision',
          '        env:',
          '          TESTED_SHA: ${{ github.event.workflow_run.head_sha }}',
          '        run: |',
          '          git fetch --no-tags origin main',
          '          if [ "$(git rev-parse HEAD)" != "$TESTED_SHA" ] || [ "$(git rev-parse origin/main)" != "$TESTED_SHA" ]; then',
          '            echo "Refusing to publish a revision that is no longer the tip of main" >&2',
          '            exit 1',
          '          fi',
          '',
          '      - name: Publish to npm',
          '        run: npm publish release/*.tgz',
        ]
      : []),
    '',
    ...(publishToNpm
      ? [
          '  release:',
          '    needs:',
          '      - check-version',
          '      - publish',
          '    if: >-',
          "      needs.check-version.result == 'success' &&",
          "      needs.check-version.outputs.should-publish == 'true' &&",
          "      needs.publish.result == 'success'",
          '    runs-on: ubuntu-latest',
          '    permissions:',
          '      contents: write',
          '',
          '    steps:',
          '      - name: Create GitHub Release',
          '        uses: softprops/action-gh-release@v3',
          '        with:',
          '          tag_name: v${{ needs.check-version.outputs.version }}',
          '          name: v${{ needs.check-version.outputs.version }}',
          '          target_commitish: ${{ github.event.workflow_run.head_sha }}',
          '          draft: false',
          '          prerelease: false',
          '          generate_release_notes: true',
        ]
      : ['# Set publishToNpm when generating this workflow to publish the assembled package.']),
    '',
  ].join('\n')
}
