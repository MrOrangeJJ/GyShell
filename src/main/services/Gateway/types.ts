import type { AgentEvent } from '../../types';
import type { ExperimentalFlags } from '../../types';

/**
 * Core event definitions, all frontend-backend communication happens through these events
 */
export type GatewayEventType = 
  | 'agent:event'        // Detailed events during agent runtime (say, tool_call, etc.)
  | 'session:update'     // Session state updates
  | 'ui:action'          // Frontend execution of specific actions (open Tab, popup, etc.)
  | 'system:notification' // System-level notifications

export interface GatewayEvent {
  id: string;
  timestamp: number;
  type: GatewayEventType;
  sessionId?: string;
  payload: AgentEvent | any;
}

/**
 * Client Transport interface for cross-platform communication
 */
export interface IClientTransport {
  id: string;
  type: 'electron' | 'websocket' | 'other';
  
  /**
   * Send a raw event to the client
   */
  send(channel: string, data: any): void;
  
  /**
   * Broadcast a GatewayEvent to this transport
   */
  emitEvent(event: GatewayEvent): void;
  
  /**
   * Send a UI update action (Backend as Source of Truth)
   */
  sendUIUpdate(action: any): void;
}

/**
 * SessionContext maintains the full state of a conversation
 */
export interface SessionContext {
  sessionId: string;
  boundTerminalId: string;
  activeRunId: string | null;      // Currently active Agent run ID
  lockedProfileId: string | null;  // Profile locked for the current busy session window
  lockedExperimentalFlags: ExperimentalFlags | null;
  abortController: AbortController | null;
  status: 'idle' | 'thinking' | 'running' | 'paused';
  metadata: Record<string, any>;
}

export type StartTaskMode = 'normal' | 'inserted';

export interface StartTaskOptions {
  startMode?: StartTaskMode;
}

/**
 * Gateway interface definition
 */
export interface IGateway {
  // Session management
  createSession(terminalId: string): Promise<string>;
  getSession(sessionId: string): SessionContext | undefined;
  
  // Task scheduling
  dispatchTask(sessionId: string, input: string, terminalId?: string, options?: StartTaskOptions): Promise<void>;
  stopTask(sessionId: string): Promise<void>;
  pauseTask(sessionId: string): Promise<void>;
  resumeTask(sessionId: string): Promise<void>;
  
  // Event distribution
  broadcast(event: Omit<GatewayEvent, 'id' | 'timestamp'>): void;
  subscribe(type: GatewayEventType, handler: (event: GatewayEvent) => void): () => void;
}

/**
 * Runtime command surface exposed to gateway adapters (IPC/WebSocket/etc.).
 * Keeping this interface transport-agnostic makes it reusable for non-Electron frontends.
 */
export interface IGatewayRuntime extends IGateway {
  registerTransport(transport: IClientTransport): void;
  unregisterTransport(transportId: string): void;
  waitForRunCompletion(sessionId: string): Promise<void>;
  submitFeedback(messageId: string, payload: any): { ok: true };
  deleteChatSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, newTitle: string): void;
  rollbackSessionToMessage(sessionId: string, messageId: string): Promise<{ ok: boolean; removedCount: number }>;
  broadcastRaw(channel: string, data: any): void;
}
