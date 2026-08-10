import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vite-plus/test'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function workflow(name) {
  return readFileSync(path.join(rootDir, '.github', 'workflows', name), 'utf8')
}

describe('independent package publishing workflows', () => {
  it('keeps the trusted publisher reusable and package-agnostic', () => {
    const publisher = workflow('publish.yml')

    expect(publisher).toContain('  workflow_call:')
    expect(publisher).toContain('package-directory:')
    expect(publisher).toContain('release-tag-prefix:')
    expect(publisher).toContain('should_publish')
    expect(publisher).toContain('should_release')
    expect(publisher).toContain('npm_registry view')
    expect(publisher).not.toContain('swift-node-unplugin')
    expect(publisher).not.toContain('swift_node_should_publish')
  })

  it.each([
    ['publish-swift-node.yml', 'packages/swift-node', 'swift-node-'],
    ['publish-swift-node-unplugin.yml', 'packages/swift-node-unplugin', 'swift-node-unplugin-'],
  ])('publishes %s independently', (name, packageDirectory, releaseTagPrefix) => {
    const publisher = workflow(name)

    expect(publisher).toContain('  workflow_run:')
    expect(publisher).toContain('workflows: [CI]')
    expect(publisher).toContain('uses: ./.github/workflows/publish.yml')
    expect(publisher).toContain(`package-directory: ${packageDirectory}`)
    expect(publisher).toContain(`release-tag-prefix: ${releaseTagPrefix}`)
  })
})
