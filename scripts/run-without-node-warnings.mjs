import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [command, ...args] = process.argv.slice(2)

if (!command) {
  throw new Error('Usage: node scripts/run-without-node-warnings.mjs <command> [args...]')
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

const child = spawn(command, args, {
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: 'inherit',
})

child.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1)
})
