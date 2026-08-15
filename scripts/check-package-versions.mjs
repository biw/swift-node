import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)

export const releasePackageManifestPaths = [
  'packages/swift-node/package.json',
  'packages/swift-node-unplugin/package.json',
]

export function assertMatchingPackageVersions(packages) {
  const versions = new Set(packages.map(({ version }) => version))

  if (versions.size !== 1) {
    const formattedPackages = packages
      .map(({ name, version }) => `  - ${name}: ${version}`)
      .join('\n')
    throw new Error(`Release package versions must match:\n${formattedPackages}`)
  }

  return packages[0].version
}

export function assertSwiftNodeUnpluginPeerVersion(packages) {
  const swiftNode = packages.find(({ name }) => name === 'swift-node')
  const unplugin = packages.find(({ name }) => name === 'swift-node-unplugin')
  if (!swiftNode || !unplugin) {
    throw new Error('Release packages must include swift-node and swift-node-unplugin')
  }

  const expectedPeerVersion = `^${swiftNode.version}`
  const peerVersion = unplugin.peerDependencies?.['swift-node']
  if (peerVersion !== expectedPeerVersion) {
    throw new Error(
      `swift-node-unplugin peerDependencies.swift-node must be ${expectedPeerVersion}; received ${peerVersion ?? '(missing)'}`,
    )
  }
}

function parseSemanticVersion(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    )
  if (!match) throw new Error(`Invalid semantic version: ${version}`)

  const prerelease = match[4]?.split('.') ?? []
  if (
    prerelease.some((identifier) => /^\d+$/.test(identifier) && !/^(0|[1-9]\d*)$/.test(identifier))
  ) {
    throw new Error(`Invalid semantic version: ${version}`)
  }

  return { core: [match[1], match[2], match[3]], prerelease }
}

function compareNumericIdentifiers(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function compareSemanticVersions(left, right) {
  const leftVersion = parseSemanticVersion(left)
  const rightVersion = parseSemanticVersion(right)

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const comparison = compareNumericIdentifiers(leftVersion.core[index], rightVersion.core[index])
    if (comparison !== 0) return comparison
  }

  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0
    return leftVersion.prerelease.length === 0 ? 1 : -1
  }

  const identifiers = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index]
    const rightIdentifier = rightVersion.prerelease[index]
    if (leftIdentifier === undefined) return -1
    if (rightIdentifier === undefined) return 1

    const leftIsNumeric = /^\d+$/.test(leftIdentifier)
    const rightIsNumeric = /^\d+$/.test(rightIdentifier)
    if (leftIsNumeric && rightIsNumeric) {
      const comparison = compareNumericIdentifiers(leftIdentifier, rightIdentifier)
      if (comparison !== 0) return comparison
      continue
    }
    if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1
    if (leftIdentifier !== rightIdentifier) return leftIdentifier < rightIdentifier ? -1 : 1
  }

  return 0
}

export function assertPackageVersionsNotLowerThanBaseline(packages, baselinePackages) {
  const baselineByName = new Map(
    baselinePackages.map((packageManifest) => [packageManifest.name, packageManifest]),
  )
  const lowerVersions = []

  for (const packageManifest of packages) {
    const baseline = baselineByName.get(packageManifest.name)
    if (!baseline) {
      throw new Error(`Baseline release packages must include ${packageManifest.name}`)
    }
    if (compareSemanticVersions(packageManifest.version, baseline.version) < 0) {
      lowerVersions.push(
        `  - ${packageManifest.name}: ${packageManifest.version} < ${baseline.version}`,
      )
    }
  }

  if (lowerVersions.length > 0) {
    throw new Error(
      `Release package versions must not be lower than main:\n${lowerVersions.join('\n')}`,
    )
  }
}

async function readReleasePackageManifests(manifestPaths, readManifest) {
  const packages = await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const contents = await readManifest(manifestPath)
      const { name, version, peerDependencies } = JSON.parse(contents)

      if (typeof name !== 'string' || typeof version !== 'string') {
        throw new Error(`${manifestPath} must define string name and version fields`)
      }

      return { name, version, peerDependencies }
    }),
  )

  return packages
}

async function readManifestFromWorkingTree(manifestPath) {
  return readFile(path.join(rootDirectory, manifestPath), 'utf8')
}

async function readManifestFromGitRef(ref, manifestPath) {
  const { stdout } = await execFileAsync('git', ['show', `${ref}:${manifestPath}`], {
    cwd: rootDirectory,
  })
  return stdout
}

export async function checkReleasePackageVersions(
  manifestPaths = releasePackageManifestPaths,
  { baselineRef } = {},
) {
  const packages = await readReleasePackageManifests(manifestPaths, readManifestFromWorkingTree)

  const version = assertMatchingPackageVersions(packages)
  assertSwiftNodeUnpluginPeerVersion(packages)
  if (baselineRef) {
    const baselinePackages = await readReleasePackageManifests(manifestPaths, (manifestPath) =>
      readManifestFromGitRef(baselineRef, manifestPath),
    )
    assertPackageVersionsNotLowerThanBaseline(packages, baselinePackages)
  }
  return version
}

function baselineRefFromArguments(argumentsList) {
  if (argumentsList.length === 0) return undefined
  if (argumentsList.length === 2 && argumentsList[0] === '--baseline-ref') return argumentsList[1]
  throw new Error('Usage: node scripts/check-package-versions.mjs [--baseline-ref <git-ref>]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const baselineRef = baselineRefFromArguments(process.argv.slice(2))
    const version = await checkReleasePackageVersions(releasePackageManifestPaths, { baselineRef })
    console.log(
      baselineRef
        ? `Release package versions match and are not lower than ${baselineRef}: ${version}`
        : `Release package versions match: ${version}`,
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
