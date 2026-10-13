/**
 * Contract for the Terminal Activity `intent` label that
 * exec_command carries into the activity timeline.
 */
import { EXEC_COMMAND_DESCRIPTION } from './builtInToolMetadata'
import { execCommandSchema } from './tools/terminal_tools'

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const runCase = (name: string, fn: () => void): void => {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

const base = { terminalId: 'term-1', command: 'ls -la', waitMode: 'wait' as const }

runCase('description tells the model to provide a short intent', () => {
  assertCondition(
    /\bintent\b/.test(EXEC_COMMAND_DESCRIPTION),
    'exec_command description must mention intent',
  )
  assertCondition(
    EXEC_COMMAND_DESCRIPTION.includes('40 characters'),
    'exec_command description must state the 40 character limit',
  )
  assertCondition(
    /not executed/.test(EXEC_COMMAND_DESCRIPTION),
    'exec_command description must say intent is not executed',
  )
})

runCase('model-facing schema requires intent', () => {
  const missing = execCommandSchema.safeParse(base)
  assertCondition(!missing.success, 'intent must be required for new tool calls')
  const ok = execCommandSchema.safeParse({ ...base, intent: 'List files' })
  assertCondition(ok.success, 'a short plain intent must be accepted')
})

runCase('intent is bounded to 40 characters', () => {
  assertCondition(
    execCommandSchema.safeParse({ ...base, intent: 'x'.repeat(40) }).success,
    'exactly 40 characters must be accepted',
  )
  assertCondition(
    !execCommandSchema.safeParse({ ...base, intent: 'x'.repeat(41) }).success,
    '41 characters must be rejected',
  )
})

runCase('intent rejects control characters (no terminal injection)', () => {
  for (const intent of ['a\nb', 'a\rb', '\u001b[31mred', 'tab\there', 'c1\u0085']) {
    assertCondition(
      !execCommandSchema.safeParse({ ...base, intent }).success,
      `intent ${JSON.stringify(intent)} must be rejected`,
    )
  }
})

runCase('schema stays strict', () => {
  assertCondition(
    !execCommandSchema.safeParse({ ...base, intent: 'ok', extra: 1 }).success,
    'unknown keys must still be rejected',
  )
})

console.log('All terminal activity description tests passed.')
