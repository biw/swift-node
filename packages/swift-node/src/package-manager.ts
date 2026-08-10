import { spawnSync } from 'node:child_process'

export const packageManagerNames = ['npm', 'pnpm', 'bun'] as const

export type PackageManagerName = (typeof packageManagerNames)[number] | 'yarn'

export type PackageManager =
  | { name: Exclude<PackageManagerName, 'yarn'>; source: 'installed'; version: string }
  | { name: 'yarn'; source: 'corepack'; version: string }

function commandVersion(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.status !== 0 || result.error) return undefined

  const version = String(result.stdout ?? '')
    .trim()
    .split(/\r?\n/, 1)[0]
    ?.replace(/^v/, '')
  return version || undefined
}

function installedVersion(name: string): string | undefined {
  return commandVersion(name, ['--version'])
}

function stableYarnVersion(): string | undefined {
  return commandVersion('corepack', ['yarn@stable', '--version'])
}

/**
 * Return package managers available on the current machine.
 *
 * Yarn is deliberately offered only through Corepack. The globally installed
 * `yarn` binary is commonly Yarn Classic (1.x), while Corepack resolves and
 * pins a current stable Yarn release for the generated project.
 */
export function findAvailablePackageManagers(
  getVersion: (name: string) => string | undefined = installedVersion,
  getStableYarnVersion: () => string | undefined = stableYarnVersion,
): PackageManager[] {
  const available: PackageManager[] = packageManagerNames.flatMap((name) => {
    const version = getVersion(name)
    return version ? [{ name, version, source: 'installed' as const }] : []
  })

  if (getVersion('corepack')) {
    const version = getStableYarnVersion()
    if (version) available.splice(1, 0, { name: 'yarn', version, source: 'corepack' })
  }

  return available
}

/** Configure the current project to use the selected Yarn version via Corepack. */
export function configureYarn(projectDir: string, version: string): void {
  const result = spawnSync('corepack', ['use', `yarn@${version}`], {
    cwd: projectDir,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  })
  if (result.status !== 0 || result.error) {
    throw new Error(`Corepack could not configure Yarn ${version}.`)
  }
}
