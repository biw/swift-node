import { describe, expect, it } from 'vite-plus/test'
import { commandInvocation, executableForPlatform } from './command.mjs'

describe('cross-platform test command runner', () => {
  it('uses setup-vp native shim on Windows', () => {
    expect(executableForPlatform('vp', 'win32')).toBe('vp.exe')
    expect(commandInvocation('vp', ['--version'], 'win32')).toEqual({
      command: 'vp.exe',
      args: ['--version'],
    })
  })

  it('runs Windows command shims through cmd.exe without enabling shell mode', () => {
    expect(executableForPlatform('pnpm', 'win32')).toBe('pnpm.cmd')
    expect(commandInvocation('pnpm', ['--version'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--version'],
    })
  })

  it('leaves commands unchanged on POSIX hosts', () => {
    expect(executableForPlatform('vp', 'linux')).toBe('vp')
    expect(commandInvocation('vp', ['--version'], 'darwin')).toEqual({
      command: 'vp',
      args: ['--version'],
    })
  })
})
