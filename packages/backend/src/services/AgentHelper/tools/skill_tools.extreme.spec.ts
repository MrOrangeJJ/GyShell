import assert from 'node:assert/strict'
import { AIMessage } from '@langchain/core/messages'
import { AgentService_v2 } from '../../AgentService_v2'
import {
  createSkillSchema,
  runCreateSkillTool,
  runSkillTool,
  skillToolSchema,
} from './skill_tools'

async function runCase(
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function createSkillRuntime(counters: Record<string, number>) {
  return {
    async getAll() {
      counters.getAll = (counters.getAll || 0) + 1
      return [{
        name: 'known-skill',
        description: 'A known skill',
        fileName: 'known.md',
        filePath: '/tmp/known.md',
        baseDir: '/tmp',
        scanRoot: '/tmp',
        isNested: false,
      }]
    },
    async readSkillContentByName() {
      counters.read = (counters.read || 0) + 1
      return {
        info: {
          name: 'known-skill',
          description: 'A known skill',
          fileName: 'known.md',
          filePath: '/tmp/known.md',
          baseDir: '/tmp',
          scanRoot: '/tmp',
          isNested: false,
        },
        content: '# Instructions',
      }
    },
    async createSkill() {
      counters.create = (counters.create || 0) + 1
      return {
        skill: {
          name: 'created-skill',
          description: 'Created',
          fileName: 'created.md',
          filePath: '/tmp/created.md',
          baseDir: '/tmp',
          scanRoot: '/tmp',
          isNested: false,
        },
      }
    },
  }
}

await runCase('skill schemas reject unknown and blank fields', () => {
  assert.equal(
    skillToolSchema.safeParse({ name: 'known-skill', extra: true }).success,
    false,
  )
  assert.equal(skillToolSchema.safeParse({ name: '   ' }).success, false)
  assert.equal(
    createSkillSchema.safeParse({
      name: 'new-skill',
      description: 'description',
      content: '# body',
      extra: true,
    }).success,
    false,
  )
  assert.equal(
    createSkillSchema.safeParse({
      name: 'new-skill',
      description: '   ',
      content: '# body',
    }).success,
    false,
  )
})

await runCase('invalid direct skill arguments perform no skill service IO', async () => {
  const counters: Record<string, number> = {}
  const service = createSkillRuntime(counters)

  const loadResult = await runSkillTool(
    { name: 'known-skill', unexpected: 'must reject' },
    service as any,
  )
  const createResult = await runCreateSkillTool(
    {
      name: 'created-skill',
      description: 'description',
      content: '# body',
      unexpected: 'must reject',
    },
    service as any,
  )

  assert.equal(loadResult.kind, 'error')
  assert.equal(createResult.kind, 'error')
  assert.deepEqual(counters, {})
})

await runCase('invalid skill calls publish no execution events', async () => {
  const counters: Record<string, number> = {}
  const events: any[] = []
  const service = new AgentService_v2(
    {
      getDisplayTerminals: () => [],
      getAllTerminals: () => [],
    } as any,
    {} as any,
    {
      isMcpToolName: () => false,
      getActiveTools: () => [],
    } as any,
    createSkillRuntime(counters) as any,
    {} as any,
    { flush: () => undefined } as any,
    {
      saveSession: () => undefined,
      loadSession: () => null,
      getAllSessions: () => [],
      getAllSessionSummaries: () => [],
    } as any,
  )
  service.setEventPublisher((_sessionId, event) => events.push(event))

  const invokeInvalidCall = async (toolCall: any) => {
    const source = new AIMessage({ content: '', tool_calls: [toolCall] })
    const batch = await (service as any)
      .createBatchToolcallExecutorNode()
      .invoke({
        sessionId: `invalid-skill-events-${String(toolCall.id)}`,
        messages: [source],
      })
    return await (service as any).createToolsNode().invoke({
      ...batch,
      pendingToolSupplementMessages: [],
    })
  }

  const invalidSkill = await invokeInvalidCall({
    id: 'invalid-skill',
    name: 'skill',
    args: { name: 'known-skill', unknown: true },
  })
  const invalidCreate = await invokeInvalidCall({
    id: 'invalid-create',
    name: 'create_skill',
    args: {
      name: 'created-skill',
      description: 'description',
      content: '# body',
      unknown: true,
    },
  })

  assert.equal(events.length, 0)
  assert.equal(counters.getAll || 0, 0)
  assert.equal(counters.create || 0, 0)
  assert.match(String(invalidSkill.messages.at(-1)?.content), /validation error/i)
  assert.match(String(invalidCreate.messages.at(-1)?.content), /validation error/i)
})
