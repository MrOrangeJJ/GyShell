import { BrowserWindow } from 'electron';
import type { IClientTransport, GatewayEvent } from '../../../backend/src/services/Gateway/types';

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
    const failures: Error[] = [];
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send(channel, data);
        } catch (error) {
          // Finish fan-out so healthy renderers are not skipped, then report
          // the ambiguous partial delivery to the terminal flow controller.
          console.warn(
            `[ElectronWindowTransport] Failed to send ${channel} to renderer ${win.webContents.id}:`,
            error,
          );
          failures.push(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    });
    if (failures.length > 0 && channel === 'terminal:data') {
      const detail = failures
        .map((failure) => failure.message)
        .filter(Boolean)
        .join('; ');
      throw new Error(
        `Failed to deliver ${channel} to ${failures.length} renderer(s)${detail ? `: ${detail}` : '.'}`,
      );
    }
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
