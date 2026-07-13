import { buildToolsForModel } from '../tools'
import { buildBuiltInToolStatusSummary } from '../../Gateway/toolingSummary'
import { BUILTIN_TOOL_INFO } from '../builtInToolMetadata'
import { computeReadFileSupport, getEnabledBuiltInTools } from './model_config'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertIncludes = <T>(values: T[], expected: T, message: string): void => {
  if (!values.includes(expected)) {
    throw new Error(`${message}. expected=${String(expected)} actual=${JSON.stringify(values)}`)
  }
}

const assertNotIncludes = <T>(values: T[], expected: T, message: string): void => {
  if (values.includes(expected)) {
    throw new Error(`${message}. unexpected=${String(expected)} actual=${JSON.stringify(values)}`)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const toolName = (tool: any): string => tool?.function?.name ?? tool?.name ?? ''
const toolDescription = (tool: any): string =>
  tool?.function?.description ?? tool?.description ?? ''

const run = async (): Promise<void> => {
  await runCase('configured text-only model disables image visibility for the whole profile', () => {
    const support = computeReadFileSupport(
      { imageInputs: true },
      { imageInputs: true },
      { imageInputs: false }
    )
    assertEqual(
      support.image,
      false,
      'profile image visibility should be disabled when any configured model lacks image support'
    )
  })

  await runCase('unset optional models do not disable profile image visibility', () => {
    const support = computeReadFileSupport(
      { imageInputs: true },
      undefined,
      undefined
    )
    assertEqual(
      support.image,
      true,
      'missing optional models should not disable image visibility'
    )
  })

  await runCase('file mutation capability exposes split model tools only', () => {
    const names = buildToolsForModel({ image: false }).map(toolName)
    assertIncludes(names, 'write_file', 'write_file should be model-visible')
    assertIncludes(names, 'edit_file', 'edit_file should be model-visible')
    assertNotIncludes(names, 'create_or_edit', 'create_or_edit should stay capability-only for model tools')
  })

  await runCase('create_or_edit capability disables split file model tools', () => {
    const enabled = getEnabledBuiltInTools(buildToolsForModel({ image: false }), {
      create_or_edit: false
    }).map(toolName)
    assertNotIncludes(enabled, 'write_file', 'write_file should be disabled by create_or_edit=false')
    assertNotIncludes(enabled, 'edit_file', 'edit_file should be disabled by create_or_edit=false')
    assertIncludes(enabled, 'exec_command', 'unrelated built-in tools should remain enabled')
  })

  await runCase('built-in status summary keeps one file mutation capability', () => {
    const names = buildBuiltInToolStatusSummary({ create_or_edit: true }).map((tool) => tool.name)
    assertIncludes(names, 'create_or_edit', 'create_or_edit should stay user-visible as the capability')
    assertNotIncludes(names, 'write_file', 'write_file should not become a settings row')
    assertNotIncludes(names, 'edit_file', 'edit_file should not become a settings row')
  })

  await runCase('built-in status summaries expose concise user descriptions', () => {
    const summaries = buildBuiltInToolStatusSummary({})
    assertEqual(
      summaries.length,
      BUILTIN_TOOL_INFO.length,
      'every configurable built-in tool should have a status summary'
    )

    for (const tool of BUILTIN_TOOL_INFO) {
      const summary = summaries.find((item) => item.name === tool.name)
      assertEqual(
        summary?.description,
        tool.userDescription,
        `${tool.name} should expose its user-facing description`
      )
      assertEqual(
        tool.userDescription.trim().length > 0,
        true,
        `${tool.name} should have a non-empty user-facing description`
      )
      assertEqual(
        tool.userDescription.includes('\n'),
        false,
        `${tool.name} user-facing description should fit on one line`
      )
      assertEqual(
        tool.userDescription.length <= 100,
        true,
        `${tool.name} user-facing description should stay concise`
      )
      assertEqual(
        tool.userDescription === tool.agentDescription,
        false,
        `${tool.name} user-facing and agent descriptions should stay separate`
      )
    }
  })

  await runCase('model tools retain agent-facing descriptions', () => {
    const execTool = buildToolsForModel({ image: false }).find(
      (tool) => toolName(tool) === 'exec_command'
    )
    const metadata = BUILTIN_TOOL_INFO.find((tool) => tool.name === 'exec_command')
    assertEqual(
      toolDescription(execTool),
      metadata?.agentDescription,
      'model tool definitions should not receive the user-facing summary'
    )
  })

  await runCase('experimental terminal lifecycle tools fail closed when settings keys are missing', () => {
    const defaults = getEnabledBuiltInTools(
      buildToolsForModel({ image: false }),
      {}
    ).map(toolName)
    assertNotIncludes(
      defaults,
      'create_terminal_tab',
      'create_terminal_tab should default to disabled'
    )
    assertNotIncludes(
      defaults,
      'close_terminal_tab',
      'close_terminal_tab should default to disabled'
    )

    const enabled = getEnabledBuiltInTools(
      buildToolsForModel({ image: false }),
      {
        create_terminal_tab: true,
        close_terminal_tab: true
      }
    ).map(toolName)
    assertIncludes(enabled, 'create_terminal_tab', 'explicit enable should expose create_terminal_tab')
    assertIncludes(enabled, 'close_terminal_tab', 'explicit enable should expose close_terminal_tab')

    const summaries = buildBuiltInToolStatusSummary({})
    const createSummary = summaries.find((tool) => tool.name === 'create_terminal_tab')
    const closeSummary = summaries.find((tool) => tool.name === 'close_terminal_tab')
    assertEqual(createSummary?.enabled, false, 'create terminal summary should default disabled')
    assertEqual(createSummary?.experimental, true, 'create terminal summary should be experimental')
    assertEqual(closeSummary?.enabled, false, 'close terminal summary should default disabled')
    assertEqual(closeSummary?.experimental, true, 'close terminal summary should be experimental')
    const malformedSummary = buildBuiltInToolStatusSummary({
      create_terminal_tab: 'yes' as any
    }).find((tool) => tool.name === 'create_terminal_tab')
    assertEqual(
      malformedSummary?.enabled,
      false,
      'non-boolean experimental settings should remain fail-closed in UI summaries'
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
