import { renderMentionText } from './MentionParser'

/**
 * Shared by:
 * 1) Chat panel tab title rendering (`components/Chat/ChatPanel.tsx`)
 * 2) Session title text normalization before display/search/rename
 */
export const CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT = 10

const truncate = (text: string, limit: number): string => {
  if (!text) return 'Untitled'
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

const normalizeTitleText = (title: string): string => {
  const text = renderMentionText(title).trim()
  return text || 'Untitled'
}

export const formatChatPanelSessionTitle = (title: string): string => {
  return truncate(normalizeTitleText(title), CHAT_PANEL_SESSION_TITLE_CHAR_LIMIT)
}

export const normalizeSessionTitleText = (title: string): string => {
  return normalizeTitleText(title)
}

export const TERMINAL_SESSION_TITLE_CHAR_LIMIT = 24
export const TERMINAL_AGENT_SESSION_FALLBACK = 'Agent'

export interface TerminalSessionTitleEntry {
  id?: string | null
  title?: string | null
}

export interface TerminalSessionTitleMaps {
  all: Map<string, string>
  active: Map<string, string>
}

const stripTerminalMentionPrefixes = (value: string): string => {
  return value
    // Mention tokens are transport metadata, not part of a terminal name.
    .replace(/\[MENTION_[A-Z0-9_]+:[^\]\r\n]*(?:\]|$)/gi, ' ')
    // Older title projections may contain a token whose closing bracket was clipped.
    .replace(/\[MENTION_[A-Z0-9_]+[^\]\r\n]*(?:\]|$)/gi, ' ')
}

/** Normalize a terminal session title without applying a presentation limit. */
export const normalizeTerminalSessionTitle = (rawTitle?: string): string => {
  if (!rawTitle) return ''

  let text = stripTerminalMentionPrefixes(String(rawTitle))
    .replace(/##[^\s]*/g, ' ')
    .replace(/[\u200b\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  text = text.replace(/^\s*(?:[@💬]\s*)+/u, '').trim()

  // Preserve a compact connection identifier in titles such as
  // TuTu_ResPi是一台... where the remainder is a description.
  const identifierDescription = text.match(/^([A-Za-z0-9_.-]{3,})[\u3400-\u9fff]/u)
  if (identifierDescription?.[1]) {
    text = identifierDescription[1]
  }

  if (!text) return ''
  if (/^(?:new session|new chat|untitled)$/i.test(text)) return ''
  return text
}

/** Compact, stable title used beside an Agent command in the Block terminal view. */
export const cleanTerminalSessionTitle = (rawTitle?: string): string => {
  const text = normalizeTerminalSessionTitle(rawTitle)
  if (!text) return ''
  const characters = Array.from(text)
  return characters.length > TERMINAL_SESSION_TITLE_CHAR_LIMIT
    ? characters.slice(0, TERMINAL_SESSION_TITLE_CHAR_LIMIT - 1).join('') + '…'
    : text
}

/**
 * Keep the complete historical lookup separate from the active-tab lookup.
 * Block rows use the active map; the details pane uses the all map after selection.
 */
export const buildTerminalSessionTitleMaps = (
  historicalTitles: Readonly<Record<string, string>>,
  activeSessions: readonly TerminalSessionTitleEntry[],
): TerminalSessionTitleMaps => {
  const all = new Map<string, string>()
  for (const [id, title] of Object.entries(historicalTitles)) {
    if (id && title) all.set(id, title)
  }

  const active = new Map<string, string>()
  for (const session of activeSessions) {
    if (session.id && session.title && cleanTerminalSessionTitle(session.title)) {
      active.set(session.id, session.title)
      all.set(session.id, session.title)
    }
  }
  return { all, active }
}

/** Resolve a selected Agent session title without allowing placeholders to leak into the UI. */
export const resolveTerminalSessionTitle = (
  rawTitle?: string,
): string =>
  normalizeTerminalSessionTitle(rawTitle) || TERMINAL_AGENT_SESSION_FALLBACK
