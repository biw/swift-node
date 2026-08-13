import { describe, expect, it } from 'vite-plus/test'
import { commandInvocationForPlatform, executableForPlatform } from '../src/command'

describe('cross-platform command resolution', () => {
  it('uses Windows command shims for package-manager commands and local binaries', () => {
    expect(executableForPlatform('pnpm', 'win32')).toBe('pnpm.cmd')
    expect(executableForPlatform('npx', 'win32')).toBe('npx.cmd')
    expect(executableForPlatform('C:\\project\\node_modules\\.bin\\tsc', 'win32')).toBe(
      'C:\\project\\node_modules\\.bin\\tsc.cmd',
    )
  })

  it('does not append a shim to executable files or POSIX commands', () => {
    expect(executableForPlatform('C:\\Program Files\\nodejs\\node.exe', 'win32')).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    )
    expect(executableForPlatform('pnpm', 'linux')).toBe('pnpm')
  })

  it('runs Windows batch shims through cmd.exe without enabling child-process shell mode', () => {
    expect(commandInvocationForPlatform('pnpm', ['--version'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--version'],
    })
    expect(
      commandInvocationForPlatform(
        'C:\\hostedtoolcache\\windows\\node\\24.18.0\\x64\\node.exe',
        ['--version'],
        'win32',
      ),
    ).toEqual({
      command: 'C:\\hostedtoolcache\\windows\\node\\24.18.0\\x64\\node.exe',
      args: ['--version'],
    })
  })
})
