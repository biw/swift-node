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
        swiftCompilerFlags: [],
        linkerFlags: [],
      })
    })
  })

  it('allows deployments with their own Swift runtime to opt out', () => {
    withProject({ name: 'my-addon', swiftNode: { shipSwiftRuntime: false } }, (projectDir) => {
      expect(readConfig(projectDir).shipSwiftRuntime).toBe(false)
    })
  })

  it('passes configured compiler and linker flags through unchanged', () => {
    withProject(
      {
        name: 'my-addon',
        swiftNode: {
          swiftCompilerFlags: ['-D', 'FEATURE_ENABLED'],
          linkerFlags: ['-L', './native-libraries', '-lExample'],
        },
      },
      (projectDir) => {
        expect(readConfig(projectDir)).toMatchObject({
          swiftCompilerFlags: ['-D', 'FEATURE_ENABLED'],
          linkerFlags: ['-L', './native-libraries', '-lExample'],
        })
      },
    )
  })

  it.each([
    ['swiftNode.swiftCompilerFlags', { swiftCompilerFlags: ['-D', 1] }],
    ['swiftNode.linkerFlags', { linkerFlags: [''] }],
    ['swiftNode.linkerFlags', { linkerFlags: ['before\0after'] }],
  ])('rejects invalid %s values', (property, swiftNode) => {
    withProject({ name: 'my-addon', swiftNode }, (projectDir) => {
      expect(() => readConfig(projectDir)).toThrow(
        `package.json ${property} must be an array of non-empty strings without NUL bytes.`,
      )
    })
  })
})
