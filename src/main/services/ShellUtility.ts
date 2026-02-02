export function escapeShellPathList(paths: string[]): string {
  const escaped = paths.map((p) => p.replace(/([\\\s'"`$])/g, '\\$1'))
  return escaped.join(' ') + (escaped.length ? ' ' : '')
}
