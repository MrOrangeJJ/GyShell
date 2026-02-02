import type { AgentEvent } from '../../types';

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
 * SessionContext maintains the full state of a conversation
 */
export interface SessionContext {
  sessionId: string;
  boundTerminalId: string;
  activeRunId: string | null;      // Currently active Agent run ID
  abortController: AbortController | null;
  status: 'idle' | 'thinking' | 'running' | 'paused';
  metadata: Record<string, any>;
}

/**
 * Gateway interface definition
 */
export interface IGateway {
  // Session management
  createSession(terminalId: string): Promise<string>;
  getSession(sessionId: string): SessionContext | undefined;
  
  // Task scheduling
  dispatchTask(sessionId: string, input: string, terminalId?: string): Promise<void>;
  stopTask(sessionId: string): Promise<void>;
  pauseTask(sessionId: string): Promise<void>;
  resumeTask(sessionId: string): Promise<void>;
  
  // Event distribution
  broadcast(event: Omit<GatewayEvent, 'id' | 'timestamp'>): void;
  subscribe(type: GatewayEventType, handler: (event: GatewayEvent) => void): () => void;
}
