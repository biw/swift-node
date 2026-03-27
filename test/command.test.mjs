import { describe, expect, it } from 'vite-plus/test'
import { executableForPlatform, executionOptionsForPlatform } from './command.mjs'

describe('cross-platform test command runner', () => {
  it('uses setup-vp native shim on Windows', () => {
    expect(executableForPlatform('vp', 'win32')).toBe('vp.exe')
    expect(executionOptionsForPlatform('vp', 'win32')).toEqual({})
  })

  it('uses Windows command shims for package-manager commands', () => {
    expect(executableForPlatform('pnpm', 'win32')).toBe('pnpm.cmd')
    expect(executionOptionsForPlatform('pnpm', 'win32')).toEqual({ shell: true })
  })

  it('leaves commands unchanged on POSIX hosts', () => {
    expect(executableForPlatform('vp', 'linux')).toBe('vp')
    expect(executionOptionsForPlatform('vp', 'darwin')).toEqual({})
  })
})
