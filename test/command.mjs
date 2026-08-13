import path from 'node:path'

export function executableForPlatform(command, platform = process.platform) {
  if (platform !== 'win32') return command
  // setup-vp provides a native `vp.exe` shim on Windows, not a .cmd wrapper.
  if (command === 'vp') return 'vp.exe'
  return path.win32.extname(command) ? command : `${command}.cmd`
}

export function commandInvocation(
  command,
  args,
  platform = process.platform,
  cmdExecutable = process.env.ComSpec ?? 'cmd.exe',
) {
  const executable = executableForPlatform(command, platform)
  const isBatchShim = platform === 'win32' && command !== 'vp' && !path.win32.extname(command)

  if (!isBatchShim) return { command: executable, args: [...args] }

  return {
    command: cmdExecutable,
    args: ['/d', '/s', '/c', executable, ...args],
  }
}
