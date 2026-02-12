export function extractText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: any) => c?.text || '').join('')
  }
  return JSON.stringify(content)
}

export function parseStrictJsonObject(text: string): unknown {
  const trimmed = (text || '').trim()
  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const jsonCandidate = trimmed.substring(firstBrace, lastBrace + 1)
    try {
      return JSON.parse(jsonCandidate)
    } catch {
      // fall through to parse full string
    }
  }
  return JSON.parse(trimmed)
}

export function markEphemeral<T extends any>(msg: T): T {
  ;(msg as any).additional_kwargs = {
    ...((msg as any).additional_kwargs || {}),
    _gyshellEphemeral: true
  }
  return msg
}

export function isEphemeral(msg: any): boolean {
  return !!msg?.additional_kwargs?._gyshellEphemeral
}
