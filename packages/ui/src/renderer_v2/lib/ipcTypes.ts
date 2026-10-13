export type BackendSettings = Awaited<ReturnType<Window['gyshell']['settings']['get']>>
export type UiSettings = Awaited<ReturnType<Window['gyshell']['uiSettings']['get']>>
export type AppSettings = BackendSettings & UiSettings
export type TerminalConfig = Parameters<Window['gyshell']['terminal']['createTab']>[0]
export type FileSystemListResult = Awaited<ReturnType<Window['gyshell']['filesystem']['list']>>
export type FileSystemEntry = FileSystemListResult['entries'][number]
export type FileTransferTaskSnapshot = Awaited<ReturnType<Window['gyshell']['filesystem']['startTransfer']>>
export type MonitorSnapshot = Awaited<ReturnType<Window['gyshell']['monitor']['snapshot']>>

export type TerminalId = string

export type TerminalTabType = TerminalConfig['type']

export type ProxyEntry = BackendSettings['connections']['proxies'][number]
export type TunnelEntry = BackendSettings['connections']['tunnels'][number]

export enum PortForwardType {
  Local = 'Local',
  Remote = 'Remote',
  Dynamic = 'Dynamic'
}

export type AppLanguage = UiSettings['language']
/** Classic (native xterm) or Block (command blocks above a docked prompt). */
export type TerminalViewMode = UiSettings['terminal']['viewMode']
export type ModelDefinition = BackendSettings['models']['items'][number]
