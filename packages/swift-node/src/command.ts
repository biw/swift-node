import path from 'node:path'

/**
 * Resolve commands that npm-style package managers expose as .cmd shims on
 * Windows. Executable files such as node.exe are left unchanged.
 */
export function executableForPlatform(command: string, platform = process.platform): string {
  if (platform !== 'win32') return command
  return path.win32.extname(command) ? command : `${command}.cmd`
}

/** Windows batch shims require cmd.exe; executable files such as node.exe do not. */
export function executionOptionsForPlatform(
  command: string,
  platform = process.platform,
): { shell?: true } {
  return platform === 'win32' && !path.win32.extname(command) ? { shell: true } : {}
}
