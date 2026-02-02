import type { GyShellAPI } from './index'

declare global {
  interface Window {
    gyshell: GyShellAPI
  }
}

