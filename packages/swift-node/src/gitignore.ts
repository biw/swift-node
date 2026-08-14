import type { PackageManagerName } from './package-manager.js'

export interface GitignoreTemplate {
  content: string
  entries: string[]
}

/** Create a project .gitignore that retains package-manager metadata needed by collaborators. */
export function gitignoreTemplate(
  packageManager: PackageManagerName | undefined,
  useTsdown: boolean,
): GitignoreTemplate {
  const dependencies =
    packageManager === 'yarn'
      ? [
          'node_modules/',
          '.pnp.*',
          '.yarn/*',
          '!.yarn/patches',
          '!.yarn/plugins',
          '!.yarn/releases',
          '!.yarn/sdks',
          '!.yarn/versions',
        ]
      : ['node_modules/', ...(packageManager === 'pnpm' ? ['.pnpm-store/'] : [])]
  const buildOutput = [
    'dist_swift-node/',
    '.swift-node-build.lock/',
    ...(useTsdown ? ['dist/'] : []),
  ]
  const logs =
    packageManager === 'yarn'
      ? ['yarn-debug.log*', 'yarn-error.log*']
      : [`${packageManager ?? 'npm'}-debug.log*`]
  const operatingSystemFiles = ['.DS_Store']
  const entries = [...dependencies, ...buildOutput, ...logs, ...operatingSystemFiles]

  return {
    entries,
    content: [
      '# Dependencies',
      ...dependencies,
      '',
      '# Build output',
      ...buildOutput,
      '',
      '# Logs',
      ...logs,
      '',
      '# Operating system files',
      ...operatingSystemFiles,
      '',
    ].join('\n'),
  }
}
