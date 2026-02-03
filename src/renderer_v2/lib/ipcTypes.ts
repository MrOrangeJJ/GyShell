export type AppSettings = Awaited<ReturnType<Window['gyshell']['settings']['get']>>
export type TerminalConfig = Parameters<Window['gyshell']['terminal']['createTab']>[0]

export type TerminalId = string

export type TerminalTabType = TerminalConfig['type']

export type ProxyEntry = AppSettings['connections']['proxies'][number]
export type TunnelEntry = AppSettings['connections']['tunnels'][number]

export enum PortForwardType {
  Local = 'Local',
  Remote = 'Remote',
  Dynamic = 'Dynamic'
}

export type AppLanguage = AppSettings['language']
export type ModelDefinition = AppSettings['models']['items'][number]
