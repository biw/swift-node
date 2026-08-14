/**
 * Infer swift-node config from the project — no config file needed.
 *
 * - moduleName: derived from package.json "name" (stripped of scope, hyphens → underscores)
 * - swiftSources: all *.swift files found in src/
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export interface SwiftNodeConfig {
  moduleName: string
  swiftSources: string[]
  minMacosVersion: string
  shipSwiftRuntime: boolean
}

function inferModuleName(projectDir: string): string {
  const pkgPath = path.join(projectDir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(
      'No package.json found. swift-node infers the module name from your package.json "name" field.',
    )
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (!pkg.name || typeof pkg.name !== 'string') {
    throw new Error('package.json must have a "name" field.')
  }

  // Strip npm scope (e.g., "@swift-node-examples/secure-storage" → "secure-storage")
  let name = pkg.name.replace(/^@[^/]+\//, '')
  // Convert hyphens to underscores for C symbol compatibility
  name = name.replace(/-/g, '_')
  return name
}

function findSwiftSources(projectDir: string): string[] {
  const srcDir = path.join(projectDir, 'src')
  if (!existsSync(srcDir)) {
    throw new Error('No src/ directory found. Put your Swift files in src/.')
  }

  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => path.join('src', f))

  if (files.length === 0) {
    throw new Error('No .swift files found in src/. Put your Swift source files in src/.')
  }

  return files
}

export function readConfig(projectDir: string): SwiftNodeConfig {
  const packageJson = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf-8')) as {
    swiftNode?: { shipSwiftRuntime?: unknown }
  }
  return {
    moduleName: inferModuleName(projectDir),
    swiftSources: findSwiftSources(projectDir),
    // AsyncStream and AsyncThrowingStream are part of Swift Node's supported
    // surface and require macOS 12 at the system ABI boundary.
    minMacosVersion: '12.0',
    // Prebuilds should be usable on machines that do not have Swift installed.
    // Consumers can opt out when their deployment already provides the runtime.
    shipSwiftRuntime: packageJson.swiftNode?.shipSwiftRuntime !== false,
  }
}
