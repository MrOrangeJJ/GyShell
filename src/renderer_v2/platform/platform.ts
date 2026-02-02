export function isWindows(): boolean {
  const plat = (window as any)?.gyshell?.system?.platform
  if (typeof plat === 'string') return plat === 'win32'
  return navigator.userAgent.toLowerCase().includes('windows')
}

