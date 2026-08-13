import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { commandInvocationForPlatform } from './command.js'

export const packageManagerNames = ['npm', 'pnpm', 'bun'] as const

export type PackageManagerName = (typeof packageManagerNames)[number] | 'yarn'

export type PackageManager =
  | { name: Exclude<PackageManagerName, 'yarn'>; source: 'installed'; version: string }
  | { name: 'yarn'; source: 'corepack'; version: string }

const packageManagerLockfiles: Array<[PackageManagerName, string]> = [
  ['pnpm', 'pnpm-lock.yaml'],
  ['yarn', 'yarn.lock'],
  ['bun', 'bun.lock'],
  ['bun', 'bun.lockb'],
  ['npm', 'package-lock.json'],
  ['npm', 'npm-shrinkwrap.json'],
]

/** Infer a project's package manager without requiring it to be installed globally. */
export function inferProjectPackageManager(projectDir: string): PackageManagerName | undefined {
  try {
    const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
    const declaredManager =
      typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@', 1)[0] : undefined
    if (declaredManager && ['npm', 'pnpm', 'bun', 'yarn'].includes(declaredManager)) {
      return declaredManager as PackageManagerName
    }
  } catch {
    // An absent or malformed manifest cannot provide a package-manager declaration.
  }

  return packageManagerLockfiles.find(([, lockfile]) =>
    existsSync(path.join(projectDir, lockfile)),
  )?.[0]
}

function commandVersion(command: string, args: string[]): string | undefined {
  const invocation = commandInvocationForPlatform(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
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
  const invocation = commandInvocationForPlatform('corepack', ['use', `yarn@${version}`])
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: projectDir,
    stdio: 'inherit',
  })
  if (result.status !== 0 || result.error) {
    throw new Error(`Corepack could not configure Yarn ${version}.`)
  }
}
