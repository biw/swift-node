import path from 'node:path'

export function executableForPlatform(command, platform = process.platform) {
  if (platform !== 'win32') return command
  // setup-vp provides a native `vp.exe` shim on Windows, not a .cmd wrapper.
  if (command === 'vp') return 'vp.exe'
  return path.win32.extname(command) ? command : `${command}.cmd`
}

export function executionOptionsForPlatform(command, platform = process.platform) {
  if (platform === 'win32' && command === 'vp') return {}
  return platform === 'win32' && !path.win32.extname(command) ? { shell: true } : {}
}
