import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

export async function checkReleasePackageVersions(manifestPaths = releasePackageManifestPaths) {
  const packages = await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const contents = await readFile(path.join(rootDirectory, manifestPath), 'utf8')
      const { name, version, peerDependencies } = JSON.parse(contents)

      if (typeof name !== 'string' || typeof version !== 'string') {
        throw new Error(`${manifestPath} must define string name and version fields`)
      }

      return { name, version, peerDependencies }
    }),
  )

  const version = assertMatchingPackageVersions(packages)
  assertSwiftNodeUnpluginPeerVersion(packages)
  return version
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const version = await checkReleasePackageVersions()
    console.log(`Release package versions match: ${version}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
