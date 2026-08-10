import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vite-plus/test'
import { executableForPlatform, executionOptionsForPlatform } from './command.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runVp(args) {
  execFileSync(executableForPlatform('vp'), args, {
    cwd: rootDir,
    stdio: 'inherit',
    ...executionOptionsForPlatform('vp'),
  })
}

describe.sequential('workspace native examples', () => {
  it('packages and unit-tests swift-node plus its tsdown plugin', () => {
    runVp(['-C', 'packages/swift-node', 'pack'])
    runVp(['-C', 'packages/swift-node', 'test'])
    runVp(['-C', 'packages/swift-node-unplugin', 'pack'])
    runVp(['-C', 'packages/swift-node-unplugin', 'test'])
  }, 180_000)

  it('builds and tests hello-world plus ESM and CommonJS consumers', () => {
    runVp(['-C', 'examples/hello-world', 'run', 'build'])
    runVp(['-C', 'examples/hello-world', 'test'])
    runVp(['-C', 'examples/hello-world-consumer-esm', 'test'])
    runVp(['-C', 'examples/hello-world-consumer-cjs', 'test'])
  }, 180_000)

  it('bundles and tests the tsdown example plus ESM and CommonJS consumers', () => {
    runVp(['-C', 'examples/hello-world-tsdown', 'run', 'build'])
    runVp(['-C', 'examples/hello-world-tsdown', 'test'])
    runVp(['-C', 'examples/hello-world-tsdown-consumer-esm', 'test'])
    runVp(['-C', 'examples/hello-world-tsdown-consumer-cjs', 'test'])
  }, 180_000)

  it('builds and tests secure-storage plus ESM and CommonJS consumers', () => {
    runVp(['-C', 'examples/secure-storage', 'run', 'build:native'])
    runVp(['-C', 'examples/secure-storage', 'run', 'build:ts'])
    runVp(['-C', 'examples/secure-storage-consumer-esm', 'run', 'build'])
    runVp(['-C', 'examples/secure-storage', 'test'])
    runVp(['-C', 'examples/secure-storage-consumer-esm', 'test'])
    runVp(['-C', 'examples/secure-storage-consumer-cjs', 'test'])
    runVp(['-C', 'examples/secure-storage-consumer-esm', 'run', 'start'])
  }, 180_000)

  it('builds and tests timer-callback plus ESM and CommonJS consumers', () => {
    runVp(['-C', 'examples/timer-callback', 'run', 'build'])
    runVp(['-C', 'examples/timer-callback', 'test'])
    runVp(['-C', 'examples/timer-callback-consumer-esm', 'test'])
    runVp(['-C', 'examples/timer-callback-consumer-cjs', 'test'])
  }, 180_000)
})
