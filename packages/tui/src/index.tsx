import { parseCliOptions, printCliHelp, resolveGatewayConnection } from './connection'
import type {
  ChatMessage,
  GatewayProfileSummary,
  GatewaySessionSnapshot,
  GatewaySessionSummary,
  SkillSummary,
  GatewayTerminalSummary,
  UIUpdateAction,
} from './protocol'
import {
  compactMessageSummary,
  formatTuiCommandOutputStatus,
  getTuiCommandOutputStatusFromMetadata,
  getTuiDisplayOutput,
} from './state'
import type { GatewayClient } from './gateway-client'

export async function startTuiCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliOptions(argv)

  if (options.help) {
    printCliHelp()
    return
  }
  if ((options.mode === 'run' || options.mode === 'hook') && !options.message?.trim()) {
    throw new Error(`Mode "${options.mode}" requires a message.`)
  }

  const { client, url } = await resolveGatewayConnection(options)

  try {
    const terminalsPayload = await client.request<{ terminals: GatewayTerminalSummary[] }>('terminal:list', {})
    const terminals = terminalsPayload.terminals ?? []
    if (terminals.length === 0) {
      throw new Error('No terminal is available on backend. Start gybackend with terminal bootstrap enabled.')
    }

    if (options.mode === 'run') {
      const target = await resolveTaskTarget(client, options.sessionId)
      client.discardBufferedUiUpdatesCoveredBySnapshot(target.uiRevision)
      await runHeadlessMode(client, target.sessionId, options.message || '')
      return
    }

    if (options.mode === 'hook') {
      const target = await resolveTaskTarget(client, options.sessionId)
      client.discardBufferedUiUpdatesCoveredBySnapshot(target.uiRevision)
      await runHookMode(client, target.sessionId, options.message || '')
      return
    }

    const profilesData = await safeRequestProfiles(client)
    const skills = await safeRequestSkills(client)
    const sessionList = await safeRequestSessionSummaries(client)
    const sessionSummaries = sessionList.sessions
    const summaryRevision = sessionSummaries.reduce<number | undefined>(
      (latest, summary) =>
        typeof summary.uiRevision === 'number' && Number.isFinite(summary.uiRevision)
          ? Math.max(latest ?? summary.uiRevision, summary.uiRevision)
          : latest,
      undefined,
    )
    client.discardBufferedUiUpdatesCoveredBySnapshot(
      sessionList.uiRevision ?? summaryRevision,
    )
    const initialSession = options.message
      ? await createInitialPromptSession(client)
      : await resolveInitialSession(client, sessionSummaries, options.sessionId)
    client.discardBufferedUiUpdatesCoveredBySnapshot(
      initialSession.uiRevision,
      initialSession.id,
    )

    const { runTui } = await import('./tui-app')
    const tuiPromise = runTui(client, {
      endpoint: url,
      terminals,
      profiles: profilesData.profiles,
      activeProfileId: profilesData.activeProfileId,
      initialSessionId: initialSession.id,
      initialSessionTitle: initialSession.title,
      initialMessages: initialSession.messages,
      initialSessionBusy: initialSession.isBusy,
      initialSessionLockedProfileId: initialSession.lockedProfileId,
      initialSessionUiRevision: initialSession.uiRevision,
      restoredSessionCount: sessionSummaries.length,
      recoveredSessions: sessionSummaries,
      skills,
    })

    if (options.message) {
      void startSessionTask(client, initialSession.id, options.message).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        process.stderr.write(`Failed to send startup message: ${detail}\n`)
      })
    }

    await tuiPromise
  } finally {
    restoreTerminalInputMode()
    client.close()
  }
}

function restoreTerminalInputMode(): void {
  if (!process.stdin.isTTY) return
  if (!process.stdin.isRaw) return
  if (typeof process.stdin.setRawMode !== 'function') return
  process.stdin.setRawMode(false)
}

async function safeRequestProfiles(client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> }) {
  try {
    const payload = await client.request<{ activeProfileId: string; profiles: GatewayProfileSummary[] }>('models:getProfiles', {})
    return {
      activeProfileId: payload.activeProfileId,
      profiles: payload.profiles ?? [],
    }
  } catch {
    return {
      activeProfileId: '',
      profiles: [] as GatewayProfileSummary[],
    }
  }
}

async function safeRequestSessionSummaries(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
): Promise<{ sessions: GatewaySessionSummary[]; uiRevision?: number }> {
  try {
    const payload = await client.request<{
      sessions: GatewaySessionSummary[]
      uiRevision?: number
    }>('session:list', {})
    return {
      sessions: payload.sessions ?? [],
      uiRevision: payload.uiRevision,
    }
  } catch {
    return { sessions: [] }
  }
}

async function safeRequestSkills(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> }
): Promise<SkillSummary[]> {
  try {
    const [allRaw, enabledRaw] = await Promise.all([
      client.request<Array<{ name: string; description?: string }>>('skills:getAll', {}),
      client.request<Array<{ name: string }>>('skills:getEnabled', {})
    ])
    const enabledSet = new Set((enabledRaw ?? []).map((item) => item.name))
    return (allRaw ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: enabledSet.has(skill.name)
    }))
  } catch {
    try {
      const payload = await client.request<{
        skills: Array<{ name: string; description?: string; enabled?: boolean }>
      }>('skills:list', {})
      return (payload.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        enabled: skill.enabled !== false
      }))
    } catch {
      return []
    }
  }
}

async function resolveInitialSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  sessions: GatewaySessionSummary[],
  preferredSessionId?: string,
): Promise<{ id: string; title: string; messages: ChatMessage[]; isBusy: boolean; lockedProfileId: string | null; uiRevision?: number }> {
  if (preferredSessionId) {
    const matched = await tryLoadSessionSnapshot(client, preferredSessionId)
    if (matched) return matched
  }

  if (sessions.length === 0) {
    const created = await createNewSession(client)
    return {
      id: created.sessionId,
      title: 'New Chat',
      messages: [],
      isBusy: false,
      lockedProfileId: null,
      uiRevision: undefined,
    }
  }

  const preferred = sessions[0]
  const firstSession = await tryLoadSessionSnapshot(client, preferred.id, preferred.title)
  if (firstSession) return firstSession

  const created = await createNewSession(client)
  return {
    id: created.sessionId,
    title: 'New Chat',
    messages: [],
    isBusy: false,
    lockedProfileId: null,
    uiRevision: undefined,
  }
}

async function tryLoadSessionSnapshot(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  sessionId: string,
  fallbackTitle?: string,
): Promise<{ id: string; title: string; messages: ChatMessage[]; isBusy: boolean; lockedProfileId: string | null; uiRevision?: number } | null> {
  try {
    const payload = await client.request<{ session: GatewaySessionSnapshot }>('session:get', {
      sessionId,
    })
    const restored = payload.session
    return {
      id: restored.id,
      title: restored.title || fallbackTitle || 'Recovered Session',
      messages: restored.messages ?? [],
      isBusy: restored.isBusy === true,
      lockedProfileId: restored.lockedProfileId || null,
      uiRevision: restored.uiRevision,
    }
  } catch {
    return null
  }
}

async function createNewSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
): Promise<{ sessionId: string }> {
  return await client.request<{ sessionId: string }>('gateway:createSession', {})
}

async function createInitialPromptSession(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
): Promise<{ id: string; title: string; messages: ChatMessage[]; isBusy: boolean; lockedProfileId: string | null; uiRevision?: number }> {
  const created = await createNewSession(client)
  return {
    id: created.sessionId,
    title: 'New Chat',
    messages: [],
    isBusy: false,
    lockedProfileId: null,
    uiRevision: undefined,
  }
}

async function resolveTaskTarget(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  preferredSessionId?: string,
): Promise<{ sessionId: string; uiRevision?: number }> {
  if (preferredSessionId) {
    const matched = await tryLoadSessionSnapshot(client, preferredSessionId)
    if (!matched) {
      throw new Error(`Session not found: ${preferredSessionId}`)
    }
    return {
      sessionId: matched.id,
      uiRevision: matched.uiRevision,
    }
  }

  const created = await createNewSession(client)
  return {
    sessionId: created.sessionId,
    uiRevision: undefined,
  }
}

async function startSessionTask(
  client: { request: <T>(method: string, params?: Record<string, unknown>) => Promise<T> },
  sessionId: string,
  userText: string,
): Promise<void> {
  await client.request('agent:startTask', {
    sessionId,
    userText,
    options: {
      startMode: 'normal',
    },
  })
}

async function runHookMode(client: GatewayClient, sessionId: string, userText: string): Promise<void> {
  await client.request('agent:startTaskAsync', {
    sessionId,
    userText,
    options: {
      startMode: 'normal',
    },
  })
}

async function runHeadlessMode(client: GatewayClient, sessionId: string, userText: string): Promise<void> {
  const outputCache = new Map<string, string>()
  const messageTypes = new Map<string, ChatMessage['type']>()
  const commandStatusCache = new Map<string, string>()

  const unsubscribeUi = client.on('uiUpdate', (update) => {
    if (update.sessionId !== sessionId) return
    handleHeadlessUiUpdate(
      client,
      update,
      outputCache,
      messageTypes,
      commandStatusCache,
    )
  })
  const unsubscribeClose = client.on('close', (code, reason) => {
    process.stderr.write(`\nGateway disconnected (${code}) ${reason}\n`)
  })
  const unsubscribeError = client.on('error', (error) => {
    process.stderr.write(`\nGateway error: ${error.message}\n`)
  })

  try {
    await startSessionTask(client, sessionId, userText)
  } finally {
    unsubscribeUi()
    unsubscribeClose()
    unsubscribeError()
  }
}

export function handleHeadlessUiUpdate(
  client: GatewayClient,
  update: UIUpdateAction,
  outputCache: Map<string, string>,
  messageTypes: Map<string, ChatMessage['type']>,
  commandStatusCache: Map<string, string>,
  write: (value: string) => unknown = (value) => process.stdout.write(value),
): void {
  if (update.type === 'ADD_MESSAGE') {
    const message = update.message
    messageTypes.set(message.id, message.type)
    outputCache.set(message.id, getTuiDisplayOutput(message.metadata))
    const commandStatus = getTuiCommandOutputStatusFromMetadata(message.metadata)
    commandStatusCache.set(
      message.id,
      commandStatus ? formatTuiCommandOutputStatus(commandStatus) : '',
    )

    if (message.type === 'ask') {
      void autoDenyAsk(client, message)
      return
    }

    if (message.role !== 'assistant') return

    if (message.type === 'text') {
      if (message.content) write(message.content)
      return
    }

    const summary = compactMessageSummary(message, true)
    if (summary) {
      write(`\n${summary}\n`)
    }
    return
  }

  if (update.type === 'APPEND_CONTENT') {
    if (update.content) write(update.content)
    return
  }

  if (update.type === 'APPEND_OUTPUT') {
    if (update.outputDelta) write(update.outputDelta)
    return
  }

  if (update.type === 'UPDATE_MESSAGE') {
    const type = messageTypes.get(update.messageId)
    if (type !== 'command' && type !== 'sub_tool' && type !== 'reasoning' && type !== 'compaction') return

    const rawNextOutput = update.patch.metadata?.output
    const previous = outputCache.get(update.messageId) || ''
    const previousStatus = commandStatusCache.get(update.messageId) || ''
    const nextOutput =
      typeof rawNextOutput === 'string'
        ? getTuiDisplayOutput(update.patch.metadata)
        : previous
    if (typeof rawNextOutput === 'string') {
      outputCache.set(update.messageId, nextOutput)
    }

    if (nextOutput) {
      const isAppend = nextOutput.startsWith(previous)
      const refreshesExcerpt =
        previous.length > 0 &&
        !isAppend &&
        (previousStatus.includes('presentation=excerpt') ||
          update.patch.metadata?.commandOutput?.presentation.state === 'excerpt')
      if (refreshesExcerpt) {
        write(
          '\n[COMMAND OUTPUT REFRESHED] Captured-output excerpt replaces the previous snapshot.\n',
        )
      }
      const delta = isAppend ? nextOutput.slice(previous.length) : nextOutput
      if (delta) write(delta)
    }

    const commandStatus = getTuiCommandOutputStatusFromMetadata(
      update.patch.metadata,
    )
    if (commandStatus) {
      const nextStatus = formatTuiCommandOutputStatus(commandStatus)
      commandStatusCache.set(update.messageId, nextStatus)
      if (type === 'command' && nextStatus !== previousStatus) {
        write(`\n[COMMAND] ${nextStatus}\n`)
      }
    }
  }
}

async function autoDenyAsk(client: GatewayClient, message: ChatMessage): Promise<void> {
  process.stderr.write('\nPermission ask received in run mode, auto-denied.\n')
  try {
    if (message.metadata?.approvalId) {
      await client.request('agent:replyCommandApproval', {
        approvalId: message.metadata.approvalId,
        decision: 'deny',
      })
      return
    }
    const messageId = message.backendMessageId || message.id
    await client.request('agent:replyMessage', {
      messageId,
      payload: { decision: 'deny' },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Auto-deny failed: ${detail}\n`)
  }
}
