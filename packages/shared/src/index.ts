export interface GyBackendEndpoint {
  host: string
  port: number
}

export interface GyBackendNodeInfo {
  id: string
  name: string
  endpoint: GyBackendEndpoint
}

export interface GyBackendConnectionConfig {
  id: string
  name: string
  protocol: 'gybackend'
  endpoint: GyBackendEndpoint
  token?: string
}

export * from './terminalConnections'
export * from './panelTabs'
export * from './theme/terminalColorSchemes'
export * from './theme/builtInSchemes'
export * from './theme/themes'
export * from './modelRequestParameters'
export * from './commandOutput'
