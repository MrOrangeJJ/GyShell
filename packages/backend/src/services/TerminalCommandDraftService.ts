import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import type { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'
import { isValidTerminalRuntimeId } from '@gyshell/shared'
import { AgentHelpers } from './AgentHelper/helpers'
import { invokeWithRetryAndSanitizedInput } from './AgentHelper/utils/model_messages'
import type { TerminalTab } from '../types'
import type { TerminalService } from './TerminalService'
import type { ISettingsRuntime } from './runtimeContracts'

const COMMAND_DRAFT_CONTEXT_LINES = 100
const MODEL_RETRY_MAX = 4
const MODEL_RETRY_DELAYS_MS = [1000, 1000, 1000, 1000]

const COMMAND_DRAFT_SCHEMA = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      'The shell command or shell snippet to paste into the current terminal tab. Do not include a trailing newline, tab id, or wait mode.'
    )
})

type CommandDraftModelBinding = {
  model: ChatOpenAI
  supportsStructuredOutput: boolean
  supportsObjectToolChoice: boolean
  profileId: string
  profileName: string
  globalModelId: string
  globalModelName: string
  resolvedModelId: string
  resolvedModelName: string
  source: 'profile_global_model'
}

export interface TerminalCommandDraftRequest {
  terminalId: string
  prompt: string
  profileId: string
}

export interface TerminalCommandDraftResult {
  command: string
}

type DraftMessageBundle = {
  messages: BaseMessage[]
  recentOutputChars: number
  recentOutputLines: number
}

export class TerminalCommandDraftService {
  private readonly helpers = new AgentHelpers()

  constructor(
    private readonly terminalService: TerminalService,
    private readonly settingsService: ISettingsRuntime
  ) {}

  async generateCommandDraft(
    request: TerminalCommandDraftRequest,
    signal?: AbortSignal
  ): Promise<TerminalCommandDraftResult> {
    const startedAt = Date.now()
    const terminalId = request.terminalId
    const prompt = String(request.prompt || '').trim()
    const profileId = String(request.profileId || '').trim()
    if (!isValidTerminalRuntimeId(terminalId)) {
      throw new Error('Missing or invalid terminalId.')
    }
    if (!prompt) {
      throw new Error('Missing prompt.')
    }
    if (!profileId) {
      throw new Error('Missing profileId.')
    }

    const terminal = this.terminalService.getTerminalById(terminalId)
    if (!terminal) {
      throw new Error(`Terminal not found: ${terminalId}`)
    }

    const binding = this.resolveCommandDraftModelBinding(profileId)
    const draftBundle = this.buildDraftMessages(terminal, prompt)
    const messages = draftBundle.messages
    const strategy = this.resolveInvocationStrategy(binding)
    console.log('[TerminalCommandDraftService] Start', {
      terminalId,
      terminalTitle: terminal.title,
      profileId: binding.profileId,
      profileName: binding.profileName,
      globalModelId: binding.globalModelId,
      globalModelName: binding.globalModelName,
      resolvedModelId: binding.resolvedModelId,
      resolvedModelName: binding.resolvedModelName,
      source: binding.source,
      strategy,
      supportsStructuredOutput: binding.supportsStructuredOutput,
      supportsObjectToolChoice: binding.supportsObjectToolChoice,
      recentOutputLines: draftBundle.recentOutputLines,
      recentOutputChars: draftBundle.recentOutputChars,
      promptChars: prompt.length,
      messageCount: messages.length
    })

    try {
      const result = await this.invokeStructuredDecision(
        binding,
        messages,
        COMMAND_DRAFT_SCHEMA,
        signal,
        'terminal_command_draft'
      )
      const command = normalizeDraftCommand(result.command)
      if (!command) {
        throw new Error('Model returned an empty command draft.')
      }

      console.log('[TerminalCommandDraftService] Finished', {
        terminalId,
        resolvedModelName: binding.resolvedModelName,
        source: binding.source,
        strategy,
        elapsedMs: Date.now() - startedAt,
        commandChars: command.length,
        commandPreview: command.slice(0, 160)
      })
      return { command }
    } catch (error) {
      console.error('[TerminalCommandDraftService] Failed', {
        terminalId,
        resolvedModelName: binding.resolvedModelName,
        source: binding.source,
        strategy,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private resolveCommandDraftModelBinding(profileId: string): CommandDraftModelBinding {
    const settings = this.settingsService.getSettings()
    const profile = settings.models.profiles.find((item) => item.id === profileId)
    if (!profile) {
      throw new Error(`Command draft profile not found: ${profileId}`)
    }

    const globalItem = settings.models.items.find((item) => item.id === profile.globalModelId)
    if (!globalItem || !globalItem.apiKey) {
      throw new Error(`Command draft global model is invalid for profile: ${profileId}`)
    }

    return {
      model: this.helpers.createChatModel(globalItem, 0.1),
      supportsStructuredOutput: globalItem.supportsStructuredOutput === true,
      supportsObjectToolChoice: globalItem.supportsObjectToolChoice === true,
      profileId,
      profileName: String(profile.name || '').trim() || profileId,
      globalModelId: globalItem.id,
      globalModelName: String(globalItem.model || globalItem.name || globalItem.id),
      resolvedModelId: globalItem.id,
      resolvedModelName: String(globalItem.model || globalItem.name || globalItem.id),
      source: 'profile_global_model'
    }
  }

  private buildDraftMessages(terminal: TerminalTab, prompt: string): DraftMessageBundle {
    const recentOutput =
      this.terminalService.getRecentOutput(terminal.id, COMMAND_DRAFT_CONTEXT_LINES) || 'No recent terminal output available.'
    const systemPrompt = [
      'You are GyShell Terminal Command Draft.',
      'Translate the user request into a shell command or shell snippet that will be pasted into the current terminal tab.',
      'You must infer the user intent by combining the user request with the recent terminal content.',
      'The recent terminal content is critical context. Use it to resolve omitted paths, filenames, commands, tools, next-step actions, and workflow state.',
      'If the user request is ambiguous or underspecified, continue the workflow that best matches the recent terminal content.',
      'You must return the answer only through the exec_command schema or tool.',
      'The schema has exactly one field: command.',
      'Do not include terminalId, waitMode, explanations, markdown fences, or a trailing newline.',
      'Do not ignore the recent terminal content when deciding what command to output.',
      'Use only the current terminal tab system info and recent visible output provided in the request.'
    ].join('\n')

    const userPrompt = [
      'CURRENT_TERMINAL_TAB:',
      `ID: ${terminal.id}`,
      `Title: ${terminal.title}`,
      `Type: ${terminal.type}`,
      `Runtime State: ${terminal.runtimeState || 'unknown'}`,
      `Remote OS: ${terminal.remoteOs || 'unknown'}`,
      `System Info: ${formatSystemInfo(terminal)}`,
      '',
      `RECENT_VISIBLE_OUTPUT_LAST_${COMMAND_DRAFT_CONTEXT_LINES}_LINES:`,
      '<terminal_content>',
      recentOutput,
      '</terminal_content>',
      '',
      'USER_REQUEST:',
      prompt
    ].join('\n')

    return {
      messages: [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      recentOutputChars: recentOutput.length,
      recentOutputLines: recentOutput.split(/\r?\n/).length
    }
  }

  private async invokeStructuredDecision<T extends z.ZodTypeAny>(
    binding: CommandDraftModelBinding,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    if (binding.supportsStructuredOutput) {
      const structuredModel = binding.model.withStructuredOutput(schema, { method: 'jsonSchema' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages,
        signal,
        operation: async (sanitizedMessages) => {
          return await structuredModel.invoke(sanitizedMessages, { signal }) as z.infer<T>
        },
        onRetry: (attempt) => {
          console.warn('[TerminalCommandDraftService] Retrying json_schema decision', {
            decisionName,
            resolvedModelName: binding.resolvedModelName,
            attempt: attempt + 1
          })
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    if (binding.supportsObjectToolChoice) {
      const functionCallingModel = binding.model.withStructuredOutput(schema, { method: 'functionCalling' })
      return await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages,
        signal,
        operation: async (sanitizedMessages) => {
          return await functionCallingModel.invoke(sanitizedMessages, { signal }) as z.infer<T>
        },
        onRetry: (attempt) => {
          console.warn('[TerminalCommandDraftService] Retrying function_calling decision', {
            decisionName,
            resolvedModelName: binding.resolvedModelName,
            attempt: attempt + 1
          })
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })
    }

    return await this.invokeByPlainToolCall(binding.model, messages, schema, signal, decisionName)
  }

  private resolveInvocationStrategy(
    binding: CommandDraftModelBinding
  ): 'json_schema' | 'function_calling' | 'plain_tool_call' {
    if (binding.supportsStructuredOutput) {
      return 'json_schema'
    }
    if (binding.supportsObjectToolChoice) {
      return 'function_calling'
    }
    return 'plain_tool_call'
  }

  private async invokeByPlainToolCall<T extends z.ZodTypeAny>(
    model: ChatOpenAI,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    const tool = convertToOpenAITool({
      name: 'exec_command',
      description:
        'Return the command draft to paste into the current terminal tab. The schema has only one field: command.',
      schema
    } as any)
    const modelWithTool = model.bindTools([tool])
    const decisionMessages = [
      ...messages,
      new HumanMessage(
        [
          'You must return the answer by calling tool "exec_command".',
          'Do not return plain text.',
          'Do not include waitMode or terminalId.',
          'Return only one tool call.'
        ].join('\n')
      )
    ]

    return await invokeWithRetryAndSanitizedInput({
      helpers: this.helpers,
      messages: decisionMessages,
      signal,
      operation: async (sanitizedMessages) => {
        const stream = await modelWithTool.stream(sanitizedMessages, { signal })
        let response: any = null
        for await (const chunk of stream) {
          response = response ? response.concat(chunk) : chunk
        }

        if (!response) {
          throw new Error(`No response was returned for ${decisionName}`)
        }

        const toolCalls = Array.isArray(response?.tool_calls) ? response.tool_calls : []
        const call = toolCalls.find((item: any) => item?.name === 'exec_command') || toolCalls[0]
        if (!call) {
          throw new Error(`No tool call was returned for ${decisionName}`)
        }

        const rawArgs =
          typeof call.args === 'string' ? this.helpers.parseStrictJsonObject(call.args) : call.args
        return schema.parse(rawArgs) as z.infer<T>
      },
      onRetry: (attempt) => {
        console.warn('[TerminalCommandDraftService] Retrying plain_tool_call decision', {
          decisionName,
          attempt: attempt + 1
        })
      },
      maxRetries: MODEL_RETRY_MAX,
      delaysMs: MODEL_RETRY_DELAYS_MS
    })
  }
}

function formatSystemInfo(terminal: TerminalTab): string {
  const info = terminal.systemInfo
  if (!info) {
    return 'Unavailable'
  }

  return [
    `os=${info.os}`,
    `platform=${info.platform}`,
    `release=${info.release}`,
    `arch=${info.arch}`,
    `hostname=${info.hostname}`,
    `remote=${info.isRemote ? 'yes' : 'no'}`,
    `shell=${info.shell || 'unknown'}`
  ].join(', ')
}

function normalizeDraftCommand(raw: string): string {
  let next = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const fenced = next.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/)
  if (fenced) {
    next = fenced[1].trim()
  }
  return next.replace(/[\n\r]+$/, '')
}
