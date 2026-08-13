import path from 'node:path'

export interface CommandInvocation {
  command: string
  args: string[]
}

/**
 * Resolve commands that npm-style package managers expose as .cmd shims on
 * Windows. Executable files such as node.exe are left unchanged.
 */
export function executableForPlatform(command: string, platform = process.platform): string {
  if (platform !== 'win32') return command
  return path.win32.extname(command) ? command : `${command}.cmd`
}

/**
 * Resolve a command to a direct child-process invocation.
 *
 * Batch shims need cmd.exe on Windows, but passing an argument array together
 * with child_process's shell option is deprecated and unsafe. Spawn cmd.exe
 * itself instead, keeping shell disabled for the actual child-process call.
 */
export function commandInvocationForPlatform(
  command: string,
  args: readonly string[],
  platform = process.platform,
  cmdExecutable = process.env.ComSpec ?? 'cmd.exe',
): CommandInvocation {
  const executable = executableForPlatform(command, platform)
  if (platform !== 'win32' || path.win32.extname(command)) {
    return { command: executable, args: [...args] }
  }

  return {
    command: cmdExecutable,
    args: ['/d', '/s', '/c', executable, ...args],
  }
}
