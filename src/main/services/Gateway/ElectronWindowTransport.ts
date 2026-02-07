import { BrowserWindow } from 'electron';
import type { IClientTransport, GatewayEvent } from './types';

/**
 * ElectronWindowTransport implements communication for local Electron windows.
 * It broadcasts messages to all open windows or a specific one.
 */
export class ElectronWindowTransport implements IClientTransport {
  public id = 'electron-main';
  public type: 'electron' = 'electron';

  /**
   * Send data to all open Electron windows via IPC
   */
  send(channel: string, data: any): void {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    });
  }

  /**
   * Emit a Gateway event to all windows
   */
  emitEvent(event: GatewayEvent): void {
    this.send('gateway:event', event);
  }

  /**
   * Send a UI update action to all windows
   */
  sendUIUpdate(action: any): void {
    this.send('agent:ui-update', action);
  }
}
