import { describe, expect, it } from 'vite-plus/test'
import { gitignoreTemplate } from '../src/gitignore'

describe('generated .gitignore', () => {
  it('uses npm defaults when no package manager was selected', () => {
    const template = gitignoreTemplate(undefined, false)

    expect(template.entries).toEqual([
      'node_modules/',
      'dist_swift-node/',
      'npm-debug.log*',
      '.DS_Store',
    ])
  })

  it('includes pnpm and Bun-specific transient files', () => {
    expect(gitignoreTemplate('pnpm', true).entries).toEqual([
      'node_modules/',
      '.pnpm-store/',
      'dist_swift-node/',
      'dist/',
      'pnpm-debug.log*',
      '.DS_Store',
    ])
    expect(gitignoreTemplate('bun', false).entries).toEqual([
      'node_modules/',
      'dist_swift-node/',
      'bun-debug.log*',
      '.DS_Store',
    ])
  })

  it('keeps Yarn Berry release and configuration files trackable', () => {
    const template = gitignoreTemplate('yarn', false)

    expect(template.entries).toContain('.yarn/*')
    expect(template.entries).toContain('!.yarn/releases')
    expect(template.entries).toContain('node_modules/')
    expect(template.entries).toContain('yarn-debug.log*')
    expect(template.entries).toContain('yarn-error.log*')
  })
})
