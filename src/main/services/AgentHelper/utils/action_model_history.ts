import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import {
  NORMAL_USER_INPUT_TAGS,
  hasAnyNormalUserInputTag,
  TAB_CONTEXT_MARKER,
  SYS_INFO_MARKER
} from '../prompts'

export function buildActionModelHistory(allMessages: BaseMessage[]): BaseMessage[] {
  const specialTags = [...NORMAL_USER_INPUT_TAGS, TAB_CONTEXT_MARKER, SYS_INFO_MARKER]
  const last3Special: BaseMessage[] = []
  for (let i = allMessages.length - 1; i >= 0 && last3Special.length < 3; i--) {
    const msg = allMessages[i]
    const content = msg.content
    if (msg.type === 'human' && typeof content === 'string' && specialTags.some((tag) => content.includes(tag))) {
      last3Special.unshift(msg)
    }
  }

  let lastUserInputIndex = -1
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i]
    const content = m.content
    if (m.type === 'human' && hasAnyNormalUserInputTag(content)) {
      lastUserInputIndex = i
      break
    }
  }

  const executionDetails = lastUserInputIndex !== -1 ? allMessages.slice(lastUserInputIndex + 1) : []
  const recentExecutionMsgs: BaseMessage[] = []
  if (executionDetails.length > 10) {
    recentExecutionMsgs.push(new HumanMessage({ content: '... (some execution details omitted) ...' }))
    recentExecutionMsgs.push(...executionDetails.slice(-10))
  } else {
    recentExecutionMsgs.push(...executionDetails)
  }

  return [...last3Special, ...recentExecutionMsgs]
}
