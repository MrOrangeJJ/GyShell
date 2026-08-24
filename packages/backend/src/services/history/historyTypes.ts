import type { ChatMessage, UIChatSession } from "../../types/ui-chat";

export interface StoredChatMessageRecord {
  id: string;
  type: string;
  data: any;
}

export interface StoredChatSessionRecord {
  id: string;
  title: string;
  messages: StoredChatMessageRecord[];
  lastCheckpointOffset: number;
  lastProfileMaxTokens?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChatSessionSummaryRecord {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  messagesCount: number;
  lastCheckpointOffset: number;
  lastProfileMaxTokens?: number;
}

export interface StoredChatSessionHeader extends ChatSessionSummaryRecord {
  runtimeStartPosition?: number;
  runtimeMarkerMessageId?: string;
}

export interface PositionedUiMessage {
  position: number;
  message: ChatMessage;
}

export interface UiMessagePage {
  sessionId: string;
  entries: PositionedUiMessage[];
  totalCount: number;
  startPosition: number | null;
  endPosition: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  uiRevision: number;
}

export interface UiMessagePageRequest {
  limit?: number;
  beforePosition?: number;
  afterPosition?: number;
  aroundPosition?: number;
}

export interface UiMessageSearchMatch {
  messageId: string;
  position: number;
  preview: string;
}

export interface UiMessageSearchResult {
  sessionId: string;
  query: string;
  matches: UiMessageSearchMatch[];
  totalMatches: number;
  truncated: boolean;
  uiRevision: number;
}

export interface UiFullMessagesResult {
  sessionId: string;
  messages: ChatMessage[];
  uiRevision: number;
}

export interface UISessionSummaryRecord {
  id: string;
  title: string;
  updatedAt: number;
  messagesCount: number;
  lastMessagePreview: string;
  uiRevision: number;
}

export interface UISessionRecord extends UIChatSession {
  messages: ChatMessage[];
}
