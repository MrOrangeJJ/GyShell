import type { AgentEvent } from '../../../types'

export function sendAgentEvent(sessionId: string, event: AgentEvent): void {
  if ((global as any).gateway) {
    ;(global as any).gateway.broadcast({
      type: 'agent:event',
      sessionId,
      payload: event
    })
    return
  }

  const { BrowserWindow } = require('electron')
  const windows = BrowserWindow.getAllWindows()
  windows.forEach((window: any) => {
    window.webContents.send('agent:event', { sessionId, event })
  })
}

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
