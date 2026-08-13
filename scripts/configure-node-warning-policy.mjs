import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const githubEnvironmentFile = process.env.GITHUB_ENV

if (!githubEnvironmentFile) {
  throw new Error('GITHUB_ENV is required to configure the CI Node warning policy')
}

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const warningPreload = `--import=${pathToFileURL(path.join(scriptsDir, 'fail-on-node-warning.mjs')).href}`
const forceNodeApiExceptions = '--force-node-api-uncaught-exceptions-policy=true'
const existingNodeOptions = process.env.NODE_OPTIONS ?? ''
const nodeOptions = [
  existingNodeOptions,
  ...(existingNodeOptions.includes(warningPreload) ? [] : [warningPreload]),
  ...(existingNodeOptions.includes(forceNodeApiExceptions) ? [] : [forceNodeApiExceptions]),
]
  .filter(Boolean)
  .join(' ')

appendFileSync(githubEnvironmentFile, `NODE_OPTIONS=${nodeOptions}\n`)
