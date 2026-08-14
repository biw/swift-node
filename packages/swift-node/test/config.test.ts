import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'
import { readConfig } from '../src/config'

function withProject(packageJson: object, callback: (projectDir: string) => void): void {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'swift-node-config-'))
  try {
    mkdirSync(path.join(projectDir, 'src'))
    writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify(packageJson))
    writeFileSync(
      path.join(projectDir, 'src', 'native.swift'),
      'func helloWorld() -> String { "Hello" }',
    )
    callback(projectDir)
  } finally {
    rmSync(projectDir, { recursive: true, force: true })
  }
}

describe('project configuration', () => {
  it('ships the Swift runtime by default', () => {
    withProject({ name: 'my-addon' }, (projectDir) => {
      expect(readConfig(projectDir)).toMatchObject({
        moduleName: 'my_addon',
        minMacosVersion: '14.0',
        shipSwiftRuntime: true,
      })
    })
  })

  it('allows deployments with their own Swift runtime to opt out', () => {
    withProject({ name: 'my-addon', swiftNode: { shipSwiftRuntime: false } }, (projectDir) => {
      expect(readConfig(projectDir).shipSwiftRuntime).toBe(false)
    })
  })
})
