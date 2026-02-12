import fs from 'fs/promises'
import path from 'path'
import { app, shell } from 'electron'
import { BashArity } from './commandArity'
import { Wildcard } from './wildcard'
import { getBashParser } from './commandParser'

export type CommandPolicyMode = 'safe' | 'standard' | 'smart'

export interface CommandPolicyLists {
  allowlist: string[]
  denylist: string[]
  asklist: string[]
}

export type CommandPolicyListName = keyof CommandPolicyLists

const DEFAULT_LISTS: CommandPolicyLists = {
  allowlist: [],
  denylist: [],
  asklist: []
}

const DEFAULT_POLICY_FILE_CONTENT = {
  allowlist: [],
  denylist: [],
  asklist: [],
  __syntax_note:
    "Wildcard rules: '*' matches any characters, '?' matches one character. A trailing ' *' (space + star) matches both the command alone and the command with args. Examples: 'ls *' matches 'ls' and 'ls -la'; 'ls' matches only 'ls'; 'ls -la' matches only that exact command."
}

export class CommandPolicyService {
  private feedbackWaiter: ((messageId: string, timeoutMs?: number) => Promise<any | null>) | null = null

  setFeedbackWaiter(waiter: (messageId: string, timeoutMs?: number) => Promise<any | null>): void {
    this.feedbackWaiter = waiter
  }

  getPolicyFilePath(): string {
    const baseDir = app.getPath('userData')
    return path.join(baseDir, 'command-policy.json')
  }

  async ensurePolicyFile(): Promise<void> {
    const filePath = this.getPolicyFilePath()
    try {
      await fs.access(filePath)
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, JSON.stringify(DEFAULT_POLICY_FILE_CONTENT, null, 2))
    }
  }

  async openPolicyFile(): Promise<void> {
    await this.ensurePolicyFile()
    const filePath = this.getPolicyFilePath()
    await shell.openPath(filePath)
  }

  async loadLists(): Promise<CommandPolicyLists> {
    await this.ensurePolicyFile()
    const filePath = this.getPolicyFilePath()
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_LISTS }
      return {
        allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist.map(String) : [],
        denylist: Array.isArray(parsed.denylist) ? parsed.denylist.map(String) : [],
        asklist: Array.isArray(parsed.asklist) ? parsed.asklist.map(String) : []
      }
    } catch {
      return { ...DEFAULT_LISTS }
    }
  }

  async getLists(): Promise<CommandPolicyLists> {
    return await this.loadLists()
  }

  async addRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    const trimmed = String(rule || '').trim()
    if (!trimmed) return await this.loadLists()

    await this.ensurePolicyFile()
    const filePath = this.getPolicyFilePath()
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '')
    let parsed: any
    try {
      parsed = raw ? JSON.parse(raw) : { ...DEFAULT_POLICY_FILE_CONTENT }
    } catch {
      parsed = { ...DEFAULT_POLICY_FILE_CONTENT }
    }

    const current = await this.loadLists()
    const next: CommandPolicyLists = {
      allowlist: current.allowlist.slice(),
      denylist: current.denylist.slice(),
      asklist: current.asklist.slice()
    }

    const arr = next[listName]
    if (!arr.includes(trimmed)) {
      arr.push(trimmed)
      arr.sort((a, b) => a.localeCompare(b))
    }

    const out = {
      ...DEFAULT_POLICY_FILE_CONTENT,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      allowlist: next.allowlist,
      denylist: next.denylist,
      asklist: next.asklist
    }

    await fs.writeFile(filePath, JSON.stringify(out, null, 2), 'utf-8')
    return next
  }

  async deleteRule(listName: CommandPolicyListName, rule: string): Promise<CommandPolicyLists> {
    const trimmed = String(rule || '').trim()
    if (!trimmed) return await this.loadLists()

    await this.ensurePolicyFile()
    const filePath = this.getPolicyFilePath()
    const raw = await fs.readFile(filePath, 'utf-8').catch(() => '')
    let parsed: any
    try {
      parsed = raw ? JSON.parse(raw) : { ...DEFAULT_POLICY_FILE_CONTENT }
    } catch {
      parsed = { ...DEFAULT_POLICY_FILE_CONTENT }
    }

    const current = await this.loadLists()
    const next: CommandPolicyLists = {
      allowlist: current.allowlist.slice(),
      denylist: current.denylist.slice(),
      asklist: current.asklist.slice()
    }

    next[listName] = next[listName].filter((x) => x !== trimmed)

    const out = {
      ...DEFAULT_POLICY_FILE_CONTENT,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      allowlist: next.allowlist,
      denylist: next.denylist,
      asklist: next.asklist
    }

    await fs.writeFile(filePath, JSON.stringify(out, null, 2), 'utf-8')
    return next
  }

  async evaluate(command: string, mode: CommandPolicyMode): Promise<'allow' | 'deny' | 'ask'> {
    const lists = await this.loadLists()
    const commandEntries = await this.parseCommandEntries(command)

    if (commandEntries.length === 0) {
      if (mode === 'safe') return 'deny'
      if (mode === 'standard') return 'ask'
      return 'allow'
    }

    let overallDecision: 'allow' | 'ask' | 'deny' = 'allow'

    for (const entry of commandEntries) {
      let entryDecision: 'allow' | 'ask' | 'deny'

      // 1. Fixed priority: Deny > Ask > Allow
      if (this.matchesList(entry.patterns, lists.denylist)) {
        entryDecision = 'deny'
      } else if (this.matchesList(entry.patterns, lists.asklist)) {
        entryDecision = 'ask'
      } else if (this.matchesList(entry.patterns, lists.allowlist)) {
        entryDecision = 'allow'
      } else {
        // 2. Default behavior
        if (mode === 'safe') entryDecision = 'deny'
        else if (mode === 'standard') entryDecision = 'ask'
        else entryDecision = 'allow' // smart
      }

      if (entryDecision === 'deny') return 'deny'
      if (entryDecision === 'ask') overallDecision = 'ask'
    }

    return overallDecision
  }

  async requestApproval(params: {
    sessionId: string
    messageId: string
    command: string
    toolName: string
    sendEvent: (sessionId: string, event: any) => void
    signal?: AbortSignal
  }): Promise<boolean> {
    if (!this.feedbackWaiter) {
      throw new Error('Feedback waiter is not initialized')
    }
    const feedbackWaiter = this.feedbackWaiter

    return new Promise<boolean>(async (resolve, reject) => {
      const onAbort = () => {
        reject(new Error('AbortError'))
      }

      if (params.signal) {
        if (params.signal.aborted) {
          onAbort()
          return
        }
        params.signal.addEventListener('abort', onAbort, { once: true })
      }

      params.sendEvent(params.sessionId, {
        type: 'command_ask',
        approvalId: params.messageId, // This is the _gyshellMessageId (backendMessageId in frontend)
        command: params.command,
        toolName: params.toolName,
        messageId: params.messageId,
        decision: undefined
      })

      try {
        console.log(`[CommandPolicyService] Waiting for feedback on messageId=${params.messageId} (backendMessageId)`);
        const feedback = await feedbackWaiter(params.messageId)
        console.log(`[CommandPolicyService] Received feedback for messageId=${params.messageId}:`, feedback);
        if (params.signal) {
          params.signal.removeEventListener('abort', onAbort)
        }

        if (!feedback) {
          // Timeout or other issue
          resolve(false)
        } else {
          resolve(feedback.decision === 'allow')
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  private matchesList(patterns: string[], list: string[]): boolean {
    if (!patterns.length || !list.length) return false
    for (const pattern of patterns) {
      for (const rule of list) {
        if (Wildcard.match(pattern, rule)) return true
      }
    }
    return false
  }

  private async parseCommandEntries(command: string): Promise<Array<{ patterns: string[] }>> {
    const parser = await getBashParser()
    const tree = parser.parse(command)
    if (!tree) {
      throw new Error('Failed to parse command')
    }
    const entries: Array<{ patterns: string[] }> = []
    for (const node of tree.rootNode.descendantsOfType('command')) {
      if (!node) continue
      const tokens: string[] = []
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child) continue
        if (
          child.type !== 'command_name' &&
          child.type !== 'word' &&
          child.type !== 'string' &&
          child.type !== 'raw_string' &&
          child.type !== 'concatenation'
        ) {
          continue
        }
        tokens.push(child.text)
      }
      if (tokens.length === 0) continue
      const patterns = new Set<string>()
      patterns.add(tokens.join(' '))
      const prefix = BashArity.prefix(tokens).join(' ')
      if (prefix) patterns.add(prefix + '*')
      entries.push({ patterns: Array.from(patterns) })
    }
    return entries
  }
}
