import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages } from '@langchain/core/messages'
import { StateGraph, START, END, Annotation, MemorySaver } from '@langchain/langgraph'
import { RunnableLambda } from '@langchain/core/runnables'
import type { ChatSession, AppSettings } from '../types'
import { TerminalService } from './TerminalService'
import { ChatHistoryService } from './ChatHistoryService'
import type { CommandPolicyService } from './CommandPolicy/CommandPolicyService'
import type { McpToolService } from './McpToolService'
import type { SkillService } from './SkillService'
import type { UIHistoryService } from './UIHistoryService'
import { v4 as uuidv4 } from 'uuid'
import type { z } from 'zod'
import {
  TOOLS_FOR_MODEL,
  buildToolsForModel,
  execCommandSchema,
  readTerminalTabSchema,
  readCommandOutputSchema,
  readFileSchema,
  writeStdinSchema,
  writeAndEditSchema,
  waitSchema,
  waitTerminalIdleSchema,
  waitCommandEndSchema,

  toolImplementations,
  buildSkillToolDescription
} from './AgentHelper/tools'
import type { ToolExecutionContext } from './AgentHelper/types'
import { AgentHelpers } from './AgentHelper/helpers'
import { ActionModelFallbackHelper } from './AgentHelper/utils/action_model_fallback'
import { buildDebugRawResponse, captureRawResponseChunk } from './AgentHelper/utils/raw_response'
import { invokeWithRetryAndSanitizedInput, stripRawResponseFromStoredMessages } from './AgentHelper/utils/model_messages'
import { createStreamReasoningExtractor } from './AgentHelper/utils/stream_reasoning_extractor'
import {
  USEFUL_SKILL_TAG,
  USER_INSERTED_INPUT_TAG,
  USER_INSERTED_INPUT_INSTRUCTION,
  createBaseSystemPrompt,
  createSystemInfoPrompt,
  createTabContextPrompt,
  COMMAND_POLICY_DECISION_SCHEMA,
  WRITE_STDIN_POLICY_DECISION_SCHEMA,
  createCommandPolicyUserPrompt,
  createWriteStdinPolicyUserPrompt,
} from './AgentHelper/prompts'
import { runSkillTool } from './AgentHelper/tools/skill_tools'
import { TokenManager } from './AgentHelper/TokenManager'
import { InputParseHelper } from './AgentHelper/InputParseHelper'

const Ann: any = Annotation

const StateAnnotation = Ann.Root({
  // Runtime Context - used for LLM inference, will be pruned
  messages: Ann({
    reducer: (x: BaseMessage[], y?: BaseMessage | BaseMessage[]) => {
      if (!y) return x

      // If a full list is provided (by token_manager), replace the entire messages state.
      if (Array.isArray(y)) {
        return y
      }
      // Otherwise, append a single message.
      return [...x, y]
    },
    default: () => []
  }),
  // Full Persistence - always append, never prune, used for saving session
  full_messages: Ann({
    reducer: (x: BaseMessage[], y?: BaseMessage | BaseMessage[]) => {
      if (!y) return x
      if (Array.isArray(y)) {
        return y
      }
      return [...x, y]
    },
    default: () => []
  }),
  // Token State - tracked separately
  token_state: Ann({
    reducer: (current: { current_tokens: number, max_tokens: number }, update?: Partial<{ current_tokens: number, max_tokens: number }>) => {
      if (!update) return current
      return { ...current, ...update }
    },
    default: () => ({ current_tokens: 0, max_tokens: 0 })
  }),
  // Add sessionId to the state to track which session this execution belongs to
  sessionId: Ann({
    reducer: (x: string, y?: string) => y ?? x,
    default: () => ""
  }),
  startup_input: Ann({
    reducer: (x: string, y?: string) => y ?? x,
    default: () => ''
  }),
  startup_mode: Ann({
    reducer: (x: 'normal' | 'inserted', y?: 'normal' | 'inserted') => y ?? x,
    default: () => 'normal'
  }),
  pendingToolCalls: Ann({
    reducer: (x: any[], y?: any[] | any) => {
      if (!y) return x
      if (Array.isArray(y)) return y
      return x
    },
    default: () => []
  })
})

const MODEL_RETRY_MAX = 4
const MODEL_RETRY_DELAYS_MS = [1000, 2000, 4000, 6000]

export class AgentService_v2 {
  private terminalService: TerminalService
  private chatHistoryService: ChatHistoryService
  private commandPolicyService: CommandPolicyService
  private mcpToolService: McpToolService
  private skillService: SkillService
  private uiHistoryService: UIHistoryService
  private model: ChatOpenAI | null = null
  private actionModel: ChatOpenAI | null = null
  private thinkingModel: ChatOpenAI | null = null
  private settings: AppSettings | null = null

  // @ts-ignore - Reserved for future use
  private unusedThinkingModel = this.thinkingModel;
  private graph: any = null
  private helpers: AgentHelpers
  private checkpointer: MemorySaver
  private toolsForModel = TOOLS_FOR_MODEL
  private builtInToolEnabled: Record<string, boolean> = {}
  private readFileSupport = { image: false }
  private lastAbortedMessage: BaseMessage | null = null
  private actionModelFallbackHelper = new ActionModelFallbackHelper()

  constructor(
    terminalService: TerminalService,
    commandPolicyService: CommandPolicyService,
    mcpToolService: McpToolService,
    skillService: SkillService,
    uiHistoryService: UIHistoryService
  ) {
    this.terminalService = terminalService
    this.chatHistoryService = new ChatHistoryService()
    this.commandPolicyService = commandPolicyService
    this.mcpToolService = mcpToolService
    this.skillService = skillService
    this.uiHistoryService = uiHistoryService
    this.helpers = new AgentHelpers()
    this.checkpointer = new MemorySaver()
    this.initializeGraph()
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings
    this.builtInToolEnabled = settings.tools?.builtIn ?? {}
    
    const activeProfileId = settings.models.activeProfileId
    
    if (!activeProfileId) {
      this.resetModels()
      return
    }

    const activeProfile = settings.models.profiles.find((p) => p.id === activeProfileId)
    if (!activeProfile) {
      console.warn('[AgentService_v2] Active profile not found:', activeProfileId)
      this.resetModels()
      return
    }

    const globalModelId = activeProfile.globalModelId
    const modelItem = settings.models.items.find((m) => m.id === globalModelId)
    
    if (!modelItem) {
      console.warn('[AgentService_v2] Active profile references a missing model item:', {
        activeProfileId,
        globalModelId
      })
      this.resetModels()
      return
    }

    if (!modelItem.apiKey) {
      console.warn('[AgentService_v2] Model item referenced but has no API Key.')
      this.resetModels()
      return
    }

    const globalModel = this.helpers.createChatModel(modelItem, 0.7)
    this.model = globalModel

    const actionModelItem = activeProfile.actionModelId
      ? settings.models.items.find((m) => m.id === activeProfile.actionModelId)
      : undefined
    this.actionModel = actionModelItem?.apiKey ? this.helpers.createChatModel(actionModelItem, 0.1) : globalModel

    const thinkingModelItem = activeProfile.thinkingModelId
      ? settings.models.items.find((m) => m.id === activeProfile.thinkingModelId)
      : undefined
    this.thinkingModel = thinkingModelItem?.apiKey ? this.helpers.createChatModel(thinkingModelItem, 0.2) : globalModel

    this.readFileSupport = this.helpers.computeReadFileSupport(modelItem.profile, thinkingModelItem?.profile ?? modelItem.profile)
    this.toolsForModel = buildToolsForModel(this.readFileSupport)
    this.initializeGraph()
  }

  private resetModels() {
    this.model = null
    this.actionModel = null
    this.thinkingModel = null
    this.toolsForModel = TOOLS_FOR_MODEL
    this.readFileSupport = { image: false }
    this.initializeGraph()
  }

  private initializeGraph(): void {
    if (!this.model) {
      this.graph = null
      return
    }

    const workflow = new StateGraph(StateAnnotation) as any

    workflow.addNode('startup_message_builder', this.createStartupMessageBuilderNode())
    // Add token_manager nodes for double interception
    workflow.addNode('token_pruner_initial', this.createTokenManagerNode())
    workflow.addNode('token_pruner_runtime', this.createTokenManagerNode())
    
    workflow.addNode('model_request', this.createModelRequestNode())
    workflow.addNode('batch_toolcall_executor', this.createBatchToolcallExecutorNode())
    workflow.addNode('tools', this.createToolsNode())
    workflow.addNode('command_tools', this.createCommandToolsNode())
    workflow.addNode('file_tools', this.createFileToolsNode())
    workflow.addNode('read_file', this.createReadFileNode())
    workflow.addNode('mcp_tools', this.createMcpToolsNode())
    workflow.addNode('final_output', this.createFinalOutputNode())

    workflow.addEdge(START, 'startup_message_builder')
    workflow.addEdge('startup_message_builder', 'token_pruner_initial')
    workflow.addEdge('token_pruner_initial', 'token_pruner_runtime')
    
    workflow.addEdge('token_pruner_runtime', 'model_request')
    
    workflow.addEdge('model_request', 'batch_toolcall_executor')
    workflow.addConditionalEdges(
      'batch_toolcall_executor',
      this.routeModelOutput,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'final_output']
    )
    
    // Tools route back to runtime pruner before model request
    workflow.addConditionalEdges(
      'tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'command_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'file_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'read_file',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    workflow.addConditionalEdges(
      'mcp_tools',
      this.routeAfterToolCall,
      ['tools', 'command_tools', 'file_tools', 'read_file', 'mcp_tools', 'token_pruner_runtime']
    )
    
    workflow.addEdge('final_output', END)

    this.graph = workflow.compile({ checkpointer: this.checkpointer })
  }

  // --- Graph Nodes ---
  
  private createTokenManagerNode() {
    return RunnableLambda.from(async (state: any) => {
      const { messages, token_state } = state
      
      // Perform pruning if needed
      if (TokenManager.isOverflow(token_state.current_tokens, token_state.max_tokens)) {
        const pruned = TokenManager.prune(messages)
        // If pruned length differs or content changed (simplified check by length or reference)
        // TokenManager.prune always returns a new array if changes were made.
        if (pruned !== messages) {
            // Debug: log when pruning actually happens
            console.log(`[TokenManager] Pruned ${messages.length - pruned.length} messages (sessionId=${state.sessionId || 'unknown'})`)
            // ONLY return messages update to trigger replacement in state.
            // DO NOT return full_messages here.
            return { messages: pruned }
        }
      }
      return {} // No op
    })
  }

  private createStartupMessageBuilderNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId
      if (!sessionId) return state

      const startupInput = String(state.startup_input || '')
      const startupMode: 'normal' | 'inserted' = state.startup_mode === 'inserted' ? 'inserted' : 'normal'

      const messages: BaseMessage[] = [...state.messages]
      const fullMessages: BaseMessage[] = [...state.full_messages]

      const userMessageId = uuidv4()
      const { enrichedContent, displayContent } = await InputParseHelper.parseAndEnrich(
        startupInput,
        this.skillService,
        this.terminalService,
        {
          userInputTag: startupMode === 'inserted' ? USER_INSERTED_INPUT_TAG : InputParseHelper.DEFAULT_USER_INPUT_TAG,
          includeContextDetails: true,
          userInputInstruction: startupMode === 'inserted' ? USER_INSERTED_INPUT_INSTRUCTION : undefined,
          keepTaggedBodyLiteral: startupMode === 'inserted'
        }
      )

      const humanMessage = new HumanMessage(enrichedContent)
      ;(humanMessage as any).additional_kwargs = {
        _gyshellMessageId: userMessageId,
        original_input: displayContent,
        input_kind: startupMode
      }

      this.helpers.sendEvent(sessionId, {
        messageId: userMessageId,
        type: 'user_input',
        content: displayContent,
        inputKind: startupMode
      })

      const withUserMessages = [...messages, humanMessage]
      const withUserFullMessages = [...fullMessages, humanMessage]

      const baseSystemMsg = createBaseSystemPrompt()
      const hasBaseSystem = withUserMessages.some(
        m => m.type === 'system' && typeof m.content === 'string' && m.content.includes('# Role: GyShell Assistant')
      )
      const fullHasBaseSystem = withUserFullMessages.some(
        m => m.type === 'system' && typeof m.content === 'string' && m.content.includes('# Role: GyShell Assistant')
      )

      const contextMessages: BaseMessage[] = []
      if (startupMode === 'normal') {
        const tabs = this.terminalService.getAllTerminals()
        const sysInfoMsg = this.helpers.markEphemeral(createSystemInfoPrompt(tabs))

        const currentTabId = state.boundTerminalId
        const currentTab = currentTabId ? tabs.find(t => t.id === currentTabId) : undefined
        const recent = currentTabId ? this.terminalService.getRecentOutput(currentTabId) : ''
        const formattedRecent = recent
          ? `
================================================================================
<terminal_content>
${recent}
</terminal_content>
================================================================================`
          : ''
        const contextMsg = this.helpers.markEphemeral(createTabContextPrompt(currentTab, formattedRecent))
        contextMessages.push(sysInfoMsg, contextMsg)
      }

      const userLast = withUserMessages[withUserMessages.length - 1]
      const beforeUser = withUserMessages.slice(0, -1)
      const newMessages = [
        ...(hasBaseSystem ? [] : [baseSystemMsg]),
        ...beforeUser,
        ...contextMessages,
        userLast
      ]

      const fullUserLast = withUserFullMessages[withUserFullMessages.length - 1]
      const fullBeforeUser = withUserFullMessages.slice(0, -1)
      const newFullMessages = [
        ...(fullHasBaseSystem ? [] : [baseSystemMsg]),
        ...fullBeforeUser,
        ...contextMessages,
        fullUserLast
      ]

      let globalMax = 200000
      let thinkingMax = 200000
      if (this.settings?.models) {
        const activeProfile = this.settings.models.profiles.find(
          (p) => p.id === this.settings?.models.activeProfileId
        )
        const globalModelId = activeProfile?.globalModelId
        const thinkingModelId = activeProfile?.thinkingModelId ?? activeProfile?.globalModelId
        const globalItem = globalModelId
          ? this.settings.models.items.find((m) => m.id === globalModelId)
          : undefined
        const thinkingItem = thinkingModelId
          ? this.settings.models.items.find((m) => m.id === thinkingModelId)
          : undefined
        if (typeof globalItem?.maxTokens === 'number') globalMax = globalItem.maxTokens
        if (typeof thinkingItem?.maxTokens === 'number') thinkingMax = thinkingItem.maxTokens
      }
      const maxTokens = Math.min(globalMax, thinkingMax)

      let currentTokens = 0
      for (let i = newFullMessages.length - 1; i >= 0; i--) {
        const m = newFullMessages[i]
        const usage = (m as any).usage_metadata || (m as any).additional_kwargs?.usage
        if (usage?.total_tokens) {
          currentTokens = usage.total_tokens
          break
        }
      }

      return {
        messages: newMessages,
        full_messages: newFullMessages,
        token_state: {
          max_tokens: maxTokens,
          current_tokens: currentTokens
        }
      }
    })
  }

  private createModelRequestNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      if (!this.model) throw new Error('Model not initialized')
      const sessionId = state.sessionId;
      if (!sessionId) throw new Error('No session ID in state');

      // Ensure we get the freshest list from disk
      await this.skillService.reload()
      const skills = await this.skillService.getEnabledSkills()
      
      // Filter built-in tools based on the latest enabled status
      const builtInTools = this.helpers.getEnabledBuiltInTools(this.toolsForModel, this.builtInToolEnabled)
      
      // Update skill tool description with latest skills
      const skillToolIndex = builtInTools.findIndex(t => t.function.name === 'skill')
      if (skillToolIndex !== -1) {
        builtInTools[skillToolIndex].function.description = buildSkillToolDescription(skills)
      }

      const mcpTools = this.mcpToolService.getActiveTools()
      const modelWithTools = this.model.bindTools([...builtInTools, ...mcpTools])

      const messageId = uuidv4()
      
      let partialText = ''
      let reasoningContent = ''
      let debugRawChunks: any[] = []
      const fullResponse = await invokeWithRetryAndSanitizedInput({
        helpers: this.helpers,
        messages: state.messages as BaseMessage[],
        signal: config?.signal,
        operation: async (streamInputMessages) => {
          const stream = await modelWithTools.stream(streamInputMessages, {
            signal: config?.signal
          })

          let response: any = null
          const streamReasoningExtractor = createStreamReasoningExtractor()
          const attemptDebugRawChunks: any[] = []
          let activeReasoningBannerId: string | null = null

          const startReasoningBanner = () => {
            if (activeReasoningBannerId) return
            activeReasoningBannerId = uuidv4()
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId,
              type: 'sub_tool_started',
              title: 'Reasoning...',
              hint: ''
            })
          }

          const appendReasoningDelta = (delta: string) => {
            if (!delta) return
            startReasoningBanner()
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId as string,
              type: 'sub_tool_delta',
              outputDelta: delta
            })
          }

          const finishReasoningBanner = () => {
            if (!activeReasoningBannerId) return
            this.helpers.sendEvent(sessionId, {
              messageId: activeReasoningBannerId,
              type: 'sub_tool_finished'
            })
            activeReasoningBannerId = null
          }
          try {
            for await (const chunk of stream) {
              const rawChunk = captureRawResponseChunk(chunk as any, attemptDebugRawChunks)
              const extracted = streamReasoningExtractor.processChunk(chunk as any, rawChunk)
              response = response ? response.concat(chunk) : chunk
              const rawDelta = this.helpers.extractText(chunk.content)
              if (rawDelta) {
                partialText += rawDelta
              }
              if (extracted.reasoning) {
                appendReasoningDelta(extracted.reasoning)
              } else {
                finishReasoningBanner()
              }
              if (extracted.content) {
                this.helpers.sendEvent(sessionId, {
                  messageId,
                  type: 'say',
                  content: extracted.content
                })
              }
            }
            const pendingContent = streamReasoningExtractor.flushPendingContent()
            if (pendingContent) {
              this.helpers.sendEvent(sessionId, {
                messageId,
                type: 'say',
                content: pendingContent
              })
            }
            finishReasoningBanner()
          } catch (err) {
            finishReasoningBanner()
            if (partialText.trim()) {
              this.lastAbortedMessage = new AIMessage({
                content: partialText,
                additional_kwargs: { _gyshellMessageId: messageId, _gyshellAborted: true }
              })
              console.log('[AgentService_v2] Captured partial message from error/abort in instance variable.')
            }
            throw err
          }
          reasoningContent = streamReasoningExtractor.getReasoningContent()
          debugRawChunks = attemptDebugRawChunks
          return response
        },
        onRetry: (attempt) => {
          this.helpers.sendEvent(sessionId, {
            type: 'alert',
            message: `Retrying (${attempt}/${MODEL_RETRY_MAX})...`,
            level: 'info',
            messageId: `retry-${messageId}-${attempt}`
          })
        },
        maxRetries: MODEL_RETRY_MAX,
        delaysMs: MODEL_RETRY_DELAYS_MS
      })

      fullResponse.additional_kwargs = {
        ...(fullResponse.additional_kwargs || {}),
        _gyshellMessageId: messageId
      }
      if (reasoningContent) {
        fullResponse.additional_kwargs.reasoning_content = reasoningContent
      }
      if (this.shouldKeepDebugPayloadInPersistence()) {
        const persistedRawResponse = buildDebugRawResponse(debugRawChunks)
        if (typeof persistedRawResponse !== 'undefined') {
          fullResponse.additional_kwargs.__raw_response = persistedRawResponse
        }
      } else if (fullResponse.additional_kwargs?.__raw_response) {
        delete fullResponse.additional_kwargs.__raw_response
      }

      // Extract usage metadata if available
      const usage = (fullResponse as any).usage_metadata || (fullResponse as any).additional_kwargs?.usage
      let currentTokens = state.token_state.current_tokens
      
      if (usage) {
        currentTokens = usage.total_tokens || usage.totalTokens || 0
        const modelName = (fullResponse as any).response_metadata?.model_name || (this.model as any)?.modelName || 'unknown'
        this.helpers.sendEvent(sessionId, {
          type: 'tokens_count',
          modelName,
          totalTokens: currentTokens,
          maxTokens: state.token_state.max_tokens // Use static max from state
        })
      }

      // Always reset pendingToolCalls here to avoid stale queue influencing routing.
      const fullHistory: BaseMessage[] = state.full_messages
      return { 
          messages: [...state.messages, fullResponse],
          full_messages: [...fullHistory, fullResponse],
          token_state: { current_tokens: currentTokens },
          sessionId, 
          pendingToolCalls: [] 
      }
    })
  }

  private createBatchToolcallExecutorNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const messages: BaseMessage[] = [...state.messages]
      const fullMessages: BaseMessage[] = [...state.full_messages]
      const lastMessage = messages[messages.length - 1]
      const fullLastMessage = fullMessages[fullMessages.length - 1]

      let pendingToolCalls: any[] = []

      if (!AIMessage.isInstance(lastMessage)) {
        return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
      }

      const toolCalls: any[] = Array.isArray((lastMessage as any).tool_calls) ? (lastMessage as any).tool_calls : []

      // Always clean tool-call chunk/invalid metadata to prevent context bloat,
      // and then decide how many tool calls we keep/enqueue.
      if (!toolCalls || toolCalls.length === 0) {
        this.cleanupModelToolCallMetadata(lastMessage, [])
        this.cleanupModelToolCallMetadata(fullLastMessage, [])
        return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
      }

      // If only one tool call, just enqueue it and continue (no extra checks needed).
      if (toolCalls.length === 1) {
        pendingToolCalls = toolCalls.slice(0, 1)
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        this.cleanupModelToolCallMetadata(fullLastMessage, pendingToolCalls)
        return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
      }

    // If ANY exec_command is present, force single-tool: keep only the first tool call.
      const hasExecCommand = toolCalls.some((tc) => tc?.name === 'exec_command')
      if (hasExecCommand) {
        pendingToolCalls = toolCalls.slice(0, 1)
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        this.cleanupModelToolCallMetadata(fullLastMessage, pendingToolCalls)
        return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
      }

      const skillCall = toolCalls.find((tc) => tc?.name === 'skill')
      if (skillCall) {
        pendingToolCalls = [skillCall]
        this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
        this.cleanupModelToolCallMetadata(fullLastMessage, pendingToolCalls)
        return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
      }

      // Otherwise (no exec_command), allow executing ALL tool calls sequentially.
      pendingToolCalls = toolCalls.slice()
      this.cleanupModelToolCallMetadata(lastMessage, pendingToolCalls)
      this.cleanupModelToolCallMetadata(fullLastMessage, pendingToolCalls)

      return { messages, full_messages: fullMessages, sessionId, pendingToolCalls }
    })
  }

  private createToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId;
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall) return state

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(
        sessionId,
        toolMessage.additional_kwargs._gyshellMessageId as string,
        config
      )
      const fullHistory: BaseMessage[] = state.full_messages
      let result = ''
      switch (toolCall.name) {
        case 'skill': {
          let args: any = toolCall.args || {}
          if (typeof args === 'string') {
            try {
              args = this.helpers.parseStrictJsonObject(args)
            } catch {
              args = {}
            }
          }
          const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'sub_tool_started',
            title: 'Skill',
            hint: `${args.name || 'unknown'}...`,
            input: JSON.stringify(args)
          })
          const outcome = await runSkillTool(args, this.skillService, config?.signal)
          result = outcome.message
          const skillContent = result.split(USEFUL_SKILL_TAG)[1].trim()

          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'sub_tool_delta',
            outputDelta: skillContent
          })

          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'sub_tool_finished'
          })
          break
        }
        case 'create_skill': {
          let args: any = toolCall.args || {}
          if (typeof args === 'string') {
            try {
              args = this.helpers.parseStrictJsonObject(args)
            } catch {
              args = {}
            }
          }
          const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
          const outcome = await toolImplementations.runCreateSkillTool(args, this.skillService, config?.signal)
          result = outcome.message
          
          // Force a reload of the graph to pick up the new tool definition if needed,
          // though the dynamic fetching in model_request node should handle it.
          // But we must ensure the local toolsForModel is updated if we use it elsewhere.
          
          this.helpers.sendEvent(sessionId, {
            messageId,
            type: 'tool_call',
            toolName: 'create_skill',
            input: JSON.stringify(args),
            output: result
          })
          break
        }
        case 'read_terminal_tab': {
          try {
            const validatedArgs = readTerminalTabSchema.parse(toolCall.args || {})
            result = await toolImplementations.readTerminalTab(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for read_terminal_tab: ${(err as Error).message}`
          }
          break
        }
        case 'read_command_output': {
          try {
            const validatedArgs = readCommandOutputSchema.parse(toolCall.args || {})
            result = await toolImplementations.readCommandOutput(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for read_command_output: ${(err as Error).message}`
          }
          break
        }
        case 'write_stdin': {
          try {
            const validatedArgs = writeStdinSchema.parse(toolCall.args || {})
            // const messageId = toolMessage.additional_kwargs._gyshellMessageId as string

            if (this.actionModel) {
              // Build temporary history for action model
              const finalActionMessages = this.helpers.buildActionModelHistory(state.full_messages as BaseMessage[])

              // Call action model for write_stdin policy check
              const user = createWriteStdinPolicyUserPrompt({ chars: validatedArgs.sequence ?? [] })
              const finalMessagesForActionModel = [...finalActionMessages, user]

              let decision: z.infer<typeof WRITE_STDIN_POLICY_DECISION_SCHEMA>
              try {
                decision = await this.getActionModelPolicyDecision(
                  sessionId,
                  finalMessagesForActionModel,
                  WRITE_STDIN_POLICY_DECISION_SCHEMA,
                  config?.signal,
                  'write_stdin'
                )
              } catch (err: any) {
                console.warn('[AgentService_v2] Action model decision for write_stdin failed after retries, falling back to allow:', err)
                decision = { decision: 'allow', reason: 'Action model error' }
              }

              if (decision.decision === 'block') {
                const blockReason = `This call was blocked because the auditor found issues: ${decision.reason}\n\nActually, your intention might be different. Please re-read the description of the write_stdin tool to confirm what you really want to do, and then call write_stdin again with the correct parameters.`
                console.log('[AgentService_v2] Action model decision for write_stdin blocked:', blockReason)
                toolMessage.content = blockReason
                return {
                  messages: [...state.messages, toolMessage],
                  full_messages: [...fullHistory, toolMessage],
                  sessionId,
                  pendingToolCalls: queue.slice(1)
                }
              }
            }

            result = await toolImplementations.writeStdin(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for write_stdin: ${(err as Error).message}`
          }
          break
        }
        case 'wait': {
          try {
            const validatedArgs = waitSchema.parse(toolCall.args || {})
            result = await toolImplementations.wait(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait: ${(err as Error).message}`
          }
          break
        }
        case 'wait_terminal_idle': {
          try {
            const validatedArgs = waitTerminalIdleSchema.parse(toolCall.args || {})
            result = await toolImplementations.waitTerminalIdle(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait_terminal_idle: ${(err as Error).message}`
          }
          break
        }
        case 'wait_command_end': {
          try {
            const validatedArgs = waitCommandEndSchema.parse(toolCall.args || {})
            result = await toolImplementations.waitCommandEnd(validatedArgs, executionContext)
          } catch (err) {
            result = `Parameter validation error for wait_command_end: ${(err as Error).message}`
          }
          break
        }
        default:
          result = `Tool "${toolCall.name}" is not supported.`
      }

      toolMessage.content = result
      return {
        messages: [...state.messages, toolMessage],
        full_messages: [...fullHistory, toolMessage],
        sessionId,
        pendingToolCalls: queue.slice(1)
      }
    })
  }

  private createCommandToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'exec_command') return state

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(sessionId, toolMessage.additional_kwargs._gyshellMessageId as string, config)
      const fullHistory: BaseMessage[] = state.full_messages

      let validated: z.infer<typeof execCommandSchema>
      try {
        validated = execCommandSchema.parse(toolCall.args || {})
      } catch (err) {
        toolMessage.content = `Parameter validation error for exec_command: ${(err as Error).message}`
        return { 
            messages: [...state.messages, toolMessage], 
            full_messages: [...fullHistory, toolMessage],
            sessionId, 
            pendingToolCalls: queue.slice(1) 
        }
      }

      const { found, bestMatch } = this.terminalService.resolveTerminal(validated.tabIdOrName)
      if (!bestMatch) {
        toolMessage.content = found.length > 1
            ? `Error: Multiple terminal tabs found with name "${validated.tabIdOrName}".`
            : `Error: Terminal tab "${validated.tabIdOrName}" not found.`
        return { 
            messages: [...state.messages, toolMessage], 
            full_messages: [...fullHistory, toolMessage],
            sessionId, 
            pendingToolCalls: queue.slice(1) 
        }
      }

      const recent = this.terminalService.getRecentOutput(bestMatch.id) || ''

      if (!this.actionModel) {
        toolMessage.content = 'Action model not initialized.'
        return { 
            messages: [...state.messages, toolMessage], 
            full_messages: [...fullHistory, toolMessage],
            sessionId, 
            pendingToolCalls: queue.slice(1) 
        }
      }

      // Build context for Action Model
      const finalActionMessages = this.helpers.buildActionModelHistory(state.full_messages as BaseMessage[])

      const user = createCommandPolicyUserPrompt({
        tabTitle: bestMatch.title,
        tabId: bestMatch.id,
        tabType: bestMatch.type,
        command: validated.command,
        recentOutput: recent
      })

      const finalMessagesForActionModel = [...finalActionMessages, user]

      let decision: z.infer<typeof COMMAND_POLICY_DECISION_SCHEMA>
      try {
        decision = await this.getActionModelPolicyDecision(
          sessionId,
          finalMessagesForActionModel,
          COMMAND_POLICY_DECISION_SCHEMA,
          config?.signal,
          'exec_command'
        )
      } catch (err: any) {
        console.warn('[AgentService_v2] Action model decision for exec_command failed after retries, falling back to wait:', err)
        decision = { decision: 'wait', reason: 'Action model error' }
      }

      let resultText = ''
      if (decision.decision === 'wait') {
        resultText = await toolImplementations.runCommand(validated, executionContext)
      } else if (decision.decision === 'nowait') {
        const res = await toolImplementations.runCommandNowait(validated, executionContext)
        resultText = res + "\nThis command may hang, so it is run asynchronously. Please use read_terminal_tab to check the result/status!"
      }

      toolMessage.content = resultText
      return { 
          messages: [...state.messages, toolMessage], 
          full_messages: [...fullHistory, toolMessage],
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }

  private createFileToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'create_or_edit') return state

      const toolMessage = this.createToolMessage(toolCall)
      const executionContext = this.createExecutionContext(sessionId, toolMessage.additional_kwargs._gyshellMessageId as string, config)
      const fullHistory: BaseMessage[] = state.full_messages

      let result: string
      try {
        const validatedArgs = writeAndEditSchema.parse(toolCall.args || {})
        result = await toolImplementations.writeAndEdit(validatedArgs, executionContext)
      } catch (err) {
        result = `Parameter validation or execution error for create_or_edit: ${(err as Error).message}`
      }

      toolMessage.content = result
      return { 
          messages: [...state.messages, toolMessage], 
          full_messages: [...fullHistory, toolMessage],
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }

  private createReadFileNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || toolCall.name !== 'read_file') return state

      const toolMessage = this.createToolMessage(toolCall)
      const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
      const executionContext = this.createExecutionContext(sessionId, messageId, config)
      const fullHistory: BaseMessage[] = state.full_messages

      let resultText: string
      let imageMessage: HumanMessage | null = null
      let meaningLessAIMessage: AIMessage | null = null

      try {
        const validatedArgs = readFileSchema.parse(toolCall.args || {})
        const result = await toolImplementations.runReadFile(validatedArgs, executionContext, this.readFileSupport)
        resultText = result.resultText
        imageMessage = result.imageMessage ?? null
        meaningLessAIMessage = result.meaningLessAIMessage ?? null
      } catch (err) {
        resultText = err instanceof Error ? err.message : String(err)
        // Ensure frontend gets a banner even on validation errors / unexpected failures.
        this.helpers.sendEvent(sessionId, {
          messageId,
          type: 'file_read',
          level: 'warning',
          filePath: String((toolCall.args as any)?.filePath || 'unknown file'),
          input: JSON.stringify(toolCall.args || {}),
          output: resultText
        })
      }

      toolMessage.content = resultText

      const updates = imageMessage
        ? [toolMessage, meaningLessAIMessage, imageMessage]
        : [toolMessage]

      return {
        messages: [...state.messages, ...updates],
        full_messages: [...fullHistory, ...(updates as BaseMessage[])],
        sessionId,
        pendingToolCalls: queue.slice(1)
      }
    })
  }

  private createMcpToolsNode() {
    return RunnableLambda.from(async (state: any, config: any) => {
      const sessionId = state.sessionId
      if (!sessionId) throw new Error('No session ID in state')

      const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
      const toolCall = queue[0]
      if (!toolCall || !this.mcpToolService.isMcpToolName(toolCall.name)) return state

      const toolMessage = this.createToolMessage(toolCall)
      const messageId = toolMessage.additional_kwargs._gyshellMessageId as string
      const fullHistory: BaseMessage[] = state.full_messages

      let args: any = toolCall.args || {}
      if (typeof args === 'string') {
        try {
          args = this.helpers.parseStrictJsonObject(args)
        } catch {}
      }

      const signal = config?.signal
      let resultText: string
      try {
        const result = await this.mcpToolService.invokeTool(toolCall.name, args, signal)
        resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
      } catch (err) {
        if (this.helpers.isAbortError(err)) throw err
        resultText = err instanceof Error ? err.message : String(err)
      }

      this.helpers.sendEvent(sessionId, {
        messageId,
        type: 'tool_call',
        toolName: toolCall.name,
        input: JSON.stringify(args ?? {}),
        output: resultText
      })

      toolMessage.content = resultText
      return { 
          messages: [...state.messages, toolMessage], 
          full_messages: [...fullHistory, toolMessage],
          sessionId, 
          pendingToolCalls: queue.slice(1) 
      }
    })
  }


  private createFinalOutputNode() {
    return RunnableLambda.from(async (state: any) => {
      const sessionId = state.sessionId;
      if (!sessionId) return state;

      // Persist UI history at task boundary (avoid sync disk writes during streaming).
      try {
        this.uiHistoryService.flush(sessionId)
      } catch (e) {
        console.warn('[AgentService_v2] Failed to flush UI history on done:', e)
      }

      this.helpers.sendEvent(sessionId, { 
        type: 'debug_history', 
        history: JSON.parse(JSON.stringify(state.messages)) 
      })
      this.helpers.sendEvent(sessionId, { type: 'done' })
      return state
    })
  }

  // --- Helpers ---

  private createToolMessage(toolCall: any): ToolMessage {
    const toolMessage = new ToolMessage({
      content: '',
      tool_call_id: toolCall.id || '',
      name: toolCall.name
    })
    const messageId = uuidv4()
    ;(toolMessage as any).additional_kwargs = { _gyshellMessageId: messageId }
    return toolMessage
  }

  private createExecutionContext(sessionId: string, messageId: string, config: any): ToolExecutionContext {
    return {
      sessionId,
      messageId,
      terminalService: this.terminalService,
      sendEvent: this.helpers.sendEvent.bind(this.helpers),
      commandPolicyService: this.commandPolicyService,
      commandPolicyMode: this.settings?.commandPolicyMode || 'standard',
      signal: config?.signal
    }
  }

  private routeModelOutput = (state: any): string => {
    const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
    const first = queue[0]
    
    if (first?.name) {
      // Security: Double-check if the tool is actually enabled before routing.
      // This prevents the Agent from calling tools that were disabled during the session.
      if (this.builtInToolEnabled[first.name] === false) {
        console.warn(`[AgentService_v2] LLM tried to call disabled tool: ${first.name}`)
        return 'final_output'
      }

      if (first.name === 'skill' || first.name === 'create_skill') return 'tools'
      if (this.mcpToolService.isMcpToolName(first.name)) return 'mcp_tools'
      if (first.name === 'exec_command') return 'command_tools'
      if (first.name === 'create_or_edit') return 'file_tools'
      if (first.name === 'read_file') return 'read_file'
      return 'tools'
    }

    return 'final_output'
  }

  private routeAfterToolCall = (state: any): string => {
    const queue: any[] = Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls : []
    const first = queue[0]
    if (!first) {
      return 'token_pruner_runtime'
    }
    if (first?.name) {
      if (this.mcpToolService.isMcpToolName(first.name)) return 'mcp_tools'
      if (first.name === 'exec_command') return 'command_tools'
      if (first.name === 'create_or_edit') return 'file_tools'
      if (first.name === 'read_file') return 'read_file'
      if (first.name === 'skill' || first.name === 'create_skill') return 'tools'
      return 'tools'
    }
    return 'token_pruner_runtime'
  }

  private cleanupModelToolCallMetadata(msg: any, keepToolCalls: any[]): void {
    // Keep only chosen tool calls (0/1/many) while removing tool-call chunk/invalid artifacts.
    if (Array.isArray(msg?.tool_calls)) {
      msg.tool_calls = Array.isArray(keepToolCalls) ? keepToolCalls : []
    }
    if (Array.isArray(msg?.invalid_tool_calls)) {
      msg.invalid_tool_calls = []
    }
    if (Array.isArray(msg?.tool_call_chunks)) {
      msg.tool_call_chunks = []
    }
    if (msg?.additional_kwargs?.tool_calls) {
      delete msg.additional_kwargs.tool_calls
    }
  }

  private shouldKeepDebugPayloadInPersistence(): boolean {
    return this.settings?.debugMode === true
  }

  private async getActionModelPolicyDecision<T extends z.ZodTypeAny>(
    sessionId: string,
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    if (!this.actionModel) {
      throw new Error('Action model not initialized')
    }

    return await this.actionModelFallbackHelper.runWithSessionFallback({
      sessionId,
      invokeStructured: async () => {
        const structuredModel = this.actionModel!.withStructuredOutput(schema)
        return await invokeWithRetryAndSanitizedInput({
          helpers: this.helpers,
          messages,
          signal,
          operation: async (sanitizedMessages) => {
            return await structuredModel.invoke(sanitizedMessages, { signal }) as any
          },
          onRetry: (attempt) => {
            console.log(`[AgentService_v2] Retrying action model decision for ${decisionName} (attempt ${attempt + 1})...`)
          },
          maxRetries: MODEL_RETRY_MAX,
          delaysMs: MODEL_RETRY_DELAYS_MS
        })
      },
      invokePseudoSchema: async () => {
        return await this.invokeActionModelPolicyDecisionWithoutSchema(messages, schema, signal, decisionName)
      },
      onFallbackTriggered: (error) => {
        console.warn(`[AgentService_v2] Structured action-model output failed for ${decisionName}. Enabling per-session pseudo-schema fallback.`, error)
      }
    })
  }

  private async invokeActionModelPolicyDecisionWithoutSchema<T extends z.ZodTypeAny>(
    messages: BaseMessage[],
    schema: T,
    signal: AbortSignal | undefined,
    decisionName: string
  ): Promise<z.infer<T>> {
    if (!this.actionModel) {
      throw new Error('Action model not initialized')
    }
    const result = await invokeWithRetryAndSanitizedInput({
      helpers: this.helpers,
      messages,
      signal,
      operation: async (sanitizedMessages) => {
        return await this.actionModel!.invoke(sanitizedMessages, { signal })
      },
      onRetry: (attempt) => {
        console.log(`[AgentService_v2] Retrying pseudo-schema action model decision for ${decisionName} (attempt ${attempt + 1})...`)
      },
      maxRetries: MODEL_RETRY_MAX,
      delaysMs: MODEL_RETRY_DELAYS_MS
    })
    const contentText = this.helpers.extractText((result as any)?.content)
    const parsed = this.helpers.parseStrictJsonObject(contentText)
    return schema.parse(parsed)
  }

  // --- Execution Core ---

  async run(context: any, input: string, signal: AbortSignal, startMode: 'normal' | 'inserted' = 'normal'): Promise<void> {
    if (!this.graph) throw new Error('Graph not initialized')

    this.lastAbortedMessage = null
    const { sessionId, boundTerminalId } = context
    this.actionModelFallbackHelper.beginSession(sessionId)
    const recursionLimit = this.settings?.recursionLimit ?? 200
    const loadedSession = this.chatHistoryService.loadSession(sessionId)
    const baseMessages = loadedSession ? mapStoredMessagesToChatMessages(Array.from(loadedSession.messages.values())) : []

    const initialState = {
      messages: [...baseMessages],
      full_messages: [...baseMessages],
      sessionId: sessionId,
      boundTerminalId: boundTerminalId,
      startup_input: input,
      startup_mode: startMode
    }

      try {
        const result = await this.graph.invoke(initialState, {
          recursionLimit: recursionLimit,
          signal,
          configurable: { thread_id: sessionId }
        })

        // Persistence
        if (result && (result.full_messages || result.messages)) {
          const finalMessages = result.full_messages || result.messages
          const sessionToSave = loadedSession || {
            id: sessionId,
            title: 'New Session',
            boundTerminalTabId: boundTerminalId,
            messages: new Map(),
            lastCheckpointOffset: 0
          }
          this.updateSessionFromMessages(sessionToSave, finalMessages as BaseMessage[])
          this.chatHistoryService.saveSession(sessionToSave)
        }
      } catch (err: any) {
        console.error(`[AgentService_v2] Run task failed (sessionId=${sessionId}):`, err)
        
        // Use our new detail extraction helper
        const errorDetails = this.helpers.extractErrorDetails(err)
        const errorMessage = err.message || String(err)

        // For any error (Abort or internal Error), try to save all history in the current Checkpoint
        await this.trySaveSessionFromCheckpoint(sessionId, boundTerminalId)
        
        if (this.helpers.isAbortError(err)) {
          return
        }
        
        // Broadcast with full details
        ;(global as any).gateway.broadcast({
          type: 'agent:event',
          sessionId,
          payload: { 
            type: 'error', 
            message: errorMessage,
            details: errorDetails
          }
        })

        throw err // Throw to Gateway for UI notification
      } finally {
      this.actionModelFallbackHelper.clearSession(sessionId)
      await this.clearCheckpoint(sessionId)
    }
  }

  private async clearCheckpoint(sessionId: string): Promise<void> {
    try {
      // Clear MemorySaver state for this thread after task completion/error.
      await this.checkpointer.deleteThread(sessionId)
    } catch {
      // best-effort cleanup
    }
  }

  private async trySaveSessionFromCheckpoint(sessionId: string, boundTerminalId: string): Promise<void> {
    if (!this.graph) return
    try {
      const snapshot = await this.graph.getState({ configurable: { thread_id: sessionId } })
      let messages = ((snapshot as any)?.values?.full_messages || (snapshot as any)?.values?.messages) as BaseMessage[] | undefined
      if (!messages || messages.length === 0) return
      
      // Check if there's an aborted message captured in the instance variable
      if (this.lastAbortedMessage) {
        console.log('[AgentService_v2] Appending aborted message from instance variable to history.')
        messages = [...messages, this.lastAbortedMessage]
        this.lastAbortedMessage = null // Clear after use
      }
      
      const session = this.chatHistoryService.loadSession(sessionId) || {
        id: sessionId,
        title: 'New Session',
        boundTerminalTabId: boundTerminalId,
        messages: new Map(),
        lastCheckpointOffset: 0
      }
      this.updateSessionFromMessages(session, messages)
      this.chatHistoryService.saveSession(session)
    } catch (error) {
      console.warn('[AgentService_v2] Failed to save session from checkpoint:', error)
    }
  }

  // --- Session Management (Legacy / Internal) ---

  private updateSessionFromMessages(session: ChatSession, messages: BaseMessage[]): void {
    let persisted = messages.filter((m) => !this.helpers.isEphemeral(m))

    // Check if the last message is an empty AI message and remove it if so
    // if (persisted.length > 0) {
    //   const lastMsg = persisted[persisted.length - 1]
    //   if (AIMessage.isInstance(lastMsg)) {
    //     const content = this.helpers.extractText(lastMsg.content).trim()
    //     const hasToolCalls = (lastMsg as AIMessage).tool_calls && (lastMsg as AIMessage).tool_calls!.length > 0
    //     if (!content && !hasToolCalls) {
    //       persisted = persisted.slice(0, -1)
    //     }
    //   }
    // }

    const storedMessages = mapChatMessagesToStoredMessages(persisted)
    if (!this.shouldKeepDebugPayloadInPersistence()) {
      stripRawResponseFromStoredMessages(storedMessages as any[])
    }
    const newMessagesMap = new Map<string, typeof storedMessages[0]>()

    for (const msg of storedMessages) {
      const msgId =
        (msg as any)?.data?.additional_kwargs?._gyshellMessageId ||
        (msg as any)?.additional_kwargs?._gyshellMessageId ||
        uuidv4()
      newMessagesMap.set(msgId, msg)
    }

    session.messages = newMessagesMap
  }

  loadChatSession(sessionId: string): ChatSession | null {
    return this.chatHistoryService.loadSession(sessionId)
  }

  deleteChatSession(sessionId: string): void {
    this.chatHistoryService.deleteSession(sessionId)
    this.uiHistoryService.deleteSession(sessionId)
  }

  renameChatSession(sessionId: string, newTitle: string): void {
    this.chatHistoryService.renameSession(sessionId, newTitle)
    this.uiHistoryService.renameSession(sessionId, newTitle)
  }

  exportChatSession(sessionId: string): any | null {
    return this.chatHistoryService.exportSession(sessionId)
  }

  rollbackToMessage(sessionId: string, messageId: string): { ok: boolean; removedCount: number } {
    const session = this.chatHistoryService.loadSession(sessionId)
    if (!session) {
      return { ok: false, removedCount: 0 }
    }

    const entries = Array.from(session.messages.entries())
    const idx = entries.findIndex(([id, msg]) => {
      if (id === messageId) return true
      const storedId = (msg as any)?.data?.additional_kwargs?._gyshellMessageId
      return storedId === messageId
    })
    if (idx === -1) {
      return { ok: false, removedCount: 0 }
    }

    const kept = entries.slice(0, idx)
    session.messages = new Map(kept)
    this.chatHistoryService.saveSession(session)

    return { ok: true, removedCount: entries.length - idx }
  }

  getAllChatHistory() {
    const backendSessions = this.chatHistoryService.getAllSessions()
    const uiSessions = this.uiHistoryService.getAllSessions()

    return backendSessions.map((backend) => {
      const ui = uiSessions.find((u) => u.id === backend.id)
      return {
        ...backend,
        title: ui?.title || backend.title,
        messagesCount: ui?.messages.length || 0
      }
    })
  }
}
