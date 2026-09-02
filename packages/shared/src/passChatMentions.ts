import {
  decodeOpaqueStringPair,
  encodeOpaqueStringPair,
  hasOnlyPairedUtf16Surrogates,
  readOpaqueNonBlankWellFormedString,
} from './opaqueIdentifiers'

export interface PassChatMentionReference {
  sessionId: string
  title?: string
}

export interface ParsedPassChatMention extends PassChatMentionReference {
  format: 'canonical-v2' | 'legacy'
}

const PASS_CHAT_MENTION_V2_PREFIX = '[MENTION_PASS_CHAT_V2:#'
const PASS_CHAT_MENTION_LEGACY_PREFIX = '[MENTION_PASS_CHAT:#'
const PASS_CHAT_MENTION_SUFFIX = '#]'
const PASS_CHAT_MENTION_CANDIDATE_PATTERN =
  /\[MENTION_PASS_CHAT(?:_V2)?:#[^\r\n]*?#\]/g
const PASS_CHAT_MENTION_PLACEHOLDER_PREFIX =
  '\uE000gyshell-pass-chat-invalid-'
const PASS_CHAT_MENTION_PLACEHOLDER_SUFFIX = '\uE001'
const PASS_CHAT_MENTION_V2_PATTERN =
  /^\[MENTION_PASS_CHAT_V2:#([^#\r\n]+)#\]$/
const PASS_CHAT_MENTION_LEGACY_PATTERN =
  /^\[MENTION_PASS_CHAT:#([^#\r\n]+?)(?:##([^#\r\n]+?))?#\]$/

const readMentionTitle = (value: unknown): string | undefined =>
  typeof value === 'string' && hasOnlyPairedUtf16Surrogates(value)
    ? value
    : undefined

const decodeLegacyMentionTitle = (value: string): string | undefined => {
  try {
    return readMentionTitle(decodeURIComponent(value))
  } catch {
    return undefined
  }
}

/**
 * Produces the canonical delimiter-safe pass-chat mention token. Session IDs
 * are opaque and retain every byte-relevant string distinction; title is
 * display metadata carried in the same collision-safe pair encoding.
 */
export const encodePassChatMentionToken = (
  sessionId: unknown,
  title: unknown = 'Chat',
): string | undefined => {
  const exactSessionId = readOpaqueNonBlankWellFormedString(sessionId)
  const exactTitle = readMentionTitle(title)
  if (exactSessionId === undefined || exactTitle === undefined) {
    return undefined
  }
  const encoded = encodeOpaqueStringPair(exactSessionId, exactTitle)
  return encoded === undefined
    ? undefined
    : `${PASS_CHAT_MENTION_V2_PREFIX}${encoded}${PASS_CHAT_MENTION_SUFFIX}`
}

/**
 * Parses canonical V2 tokens and the unambiguous subset of the historical raw
 * token format. Canonical-looking malformed input never falls back to legacy
 * parsing.
 */
export const parsePassChatMentionToken = (
  value: unknown,
): ParsedPassChatMention | undefined => {
  if (typeof value !== 'string') return undefined

  if (value.startsWith(PASS_CHAT_MENTION_V2_PREFIX)) {
    const match = value.match(PASS_CHAT_MENTION_V2_PATTERN)
    if (!match) return undefined
    const pair = decodeOpaqueStringPair(match[1])
    if (!pair) return undefined
    const sessionId = readOpaqueNonBlankWellFormedString(pair[0])
    const title = readMentionTitle(pair[1])
    if (sessionId === undefined || title === undefined) return undefined
    return { sessionId, title, format: 'canonical-v2' }
  }

  if (!value.startsWith(PASS_CHAT_MENTION_LEGACY_PREFIX)) return undefined
  const match = value.match(PASS_CHAT_MENTION_LEGACY_PATTERN)
  if (!match) return undefined
  const sessionId = readOpaqueNonBlankWellFormedString(match[1])
  if (sessionId === undefined) return undefined
  if (match[2] === undefined) {
    return { sessionId, format: 'legacy' }
  }
  const title = decodeLegacyMentionTitle(match[2])
  return title === undefined
    ? undefined
    : { sessionId, title, format: 'legacy' }
}

export const extractPassChatMentionReferences = (
  value: unknown,
): PassChatMentionReference[] => {
  if (typeof value !== 'string') return []
  const references: PassChatMentionReference[] = []
  for (const match of value.matchAll(PASS_CHAT_MENTION_CANDIDATE_PATTERN)) {
    const parsed = parsePassChatMentionToken(match[0])
    if (!parsed) continue
    references.push({
      sessionId: parsed.sessionId,
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
    })
  }
  return references
}

export const replacePassChatMentionTokens = (
  value: string,
  replacer: (reference: PassChatMentionReference, token: string) => string,
): string =>
  value.replace(PASS_CHAT_MENTION_CANDIDATE_PATTERN, (token) => {
    const parsed = parsePassChatMentionToken(token)
    if (!parsed) return token
    return replacer(
      {
        sessionId: parsed.sessionId,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      },
      token,
    )
  })

export const renderPassChatMentionTokensAsText = (value: string): string =>
  replacePassChatMentionTokens(
    value,
    (reference) => `@Pass Chat: ${reference.title || 'Chat'}`
  )

/**
 * Renders valid pass-chat references while keeping malformed complete tokens
 * byte-for-byte literal through a caller-supplied text normalization step.
 * This is useful for compact UIs whose markdown cleanup would otherwise strip
 * the token's brackets or hash delimiters.
 */
export const transformPassChatMentionText = (
  value: string,
  transform: (value: string) => string,
): string => {
  const invalidTokens: Array<{ token: string; placeholder: string }> = []
  let nextPlaceholderIndex = 0
  let guarded = value.replace(PASS_CHAT_MENTION_CANDIDATE_PATTERN, (token) => {
    if (parsePassChatMentionToken(token)) return token

    let placeholder = ''
    do {
      placeholder = `${PASS_CHAT_MENTION_PLACEHOLDER_PREFIX}${nextPlaceholderIndex}${PASS_CHAT_MENTION_PLACEHOLDER_SUFFIX}`
      nextPlaceholderIndex += 1
    } while (value.includes(placeholder))

    invalidTokens.push({ token, placeholder })
    return placeholder
  })

  guarded = renderPassChatMentionTokensAsText(guarded)
  let transformed = transform(guarded)
  for (const { token, placeholder } of invalidTokens) {
    transformed = transformed.split(placeholder).join(token)
  }
  return transformed
}
