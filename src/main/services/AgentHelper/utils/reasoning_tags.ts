export const THINKING_TAG_NAMES = new Set([
  'think',
  'thinking',
  'thought',
  'antthinking'
])
export const THINKING_TAG_SCAN_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gi

export type ParsedReasoningTag = {
  isThinkingTag: boolean
  closing: boolean
}

export function parseReasoningTag(rawTag: string): ParsedReasoningTag | null {
  const match = rawTag.match(/^<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>$/i)
  if (!match) return null
  return {
    isThinkingTag: true,
    closing: match[1] === '/',
  }
}

export function hasThinkingTag(text: string): boolean {
  if (!text) return false
  THINKING_TAG_SCAN_RE.lastIndex = 0
  const matched = THINKING_TAG_SCAN_RE.test(text)
  THINKING_TAG_SCAN_RE.lastIndex = 0
  return matched
}

export function splitStableAndCarryTagText(text: string): { stable: string; carry: string } {
  if (!text) return { stable: '', carry: '' }
  const lastLt = text.lastIndexOf('<')
  if (lastLt === -1) return { stable: text, carry: '' }
  const lastGt = text.lastIndexOf('>')
  if (lastGt > lastLt) return { stable: text, carry: '' }
  return {
    stable: text.slice(0, lastLt),
    carry: text.slice(lastLt)
  }
}
