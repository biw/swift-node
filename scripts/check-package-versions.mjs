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

export async function checkReleasePackageVersions(manifestPaths = releasePackageManifestPaths) {
  const packages = await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const contents = await readFile(path.join(rootDirectory, manifestPath), 'utf8')
      const { name, version } = JSON.parse(contents)

      if (typeof name !== 'string' || typeof version !== 'string') {
        throw new Error(`${manifestPath} must define string name and version fields`)
      }

      return { name, version }
    }),
  )

  return assertMatchingPackageVersions(packages)
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
