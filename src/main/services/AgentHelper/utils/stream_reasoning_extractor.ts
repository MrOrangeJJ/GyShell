import { extractText } from './common'
import {
  THINKING_TAG_SCAN_RE,
  hasThinkingTag,
  parseReasoningTag,
  splitStableAndCarryTagText
} from './reasoning_tags'

type ReasoningMode = 'unknown' | 'raw_reasoning_content' | 'raw_reasoning_details' | 'tagged'

function normalizeRawReasoning(rawChunk: any): { direct: string; fromDetails: string } {
  const delta = rawChunk?.choices?.[0]?.delta
  const directCandidates = [delta?.reasoning_content, delta?.reasoning, delta?.thinking]
  const direct = directCandidates.find((v) => typeof v === 'string' && v.length > 0) || ''

  const details = delta?.reasoning_details
  if (!details) {
    return { direct, fromDetails: '' }
  }

  if (Array.isArray(details)) {
    const text = details
      .filter((item) => item && typeof item.text === 'string')
      .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0))
      .map((item) => item.text as string)
      .join('')
    return { direct, fromDetails: text }
  }

  if (typeof details === 'object') {
    const text = Object.values(details as Record<string, any>)
      .filter((item) => item && typeof item.text === 'string')
      .sort((a, b) => Number(a?.index ?? 0) - Number(b?.index ?? 0))
      .map((item) => item.text as string)
      .join('')
    return { direct, fromDetails: text }
  }

  return { direct, fromDetails: '' }
}

export class StreamReasoningExtractor {
  private mode: ReasoningMode = 'unknown'
  private reasoningBuffer = ''
  private unknownCarry = ''
  private taggedBuffer = ''
  private taggedInThinking = false

  processChunk(processedChunk: any, rawChunk: any): { content: string; reasoning: string } {
    const contentText = extractText(processedChunk?.content)
    const raw = normalizeRawReasoning(rawChunk)

    if (this.mode === 'unknown') {
      if (raw.direct) {
        this.mode = 'raw_reasoning_content'
      } else if (raw.fromDetails) {
        this.mode = 'raw_reasoning_details'
      } else if (hasThinkingTag(`${this.unknownCarry}${contentText}`)) {
        this.mode = 'tagged'
      }
    }

    if (this.mode === 'raw_reasoning_content' || this.mode === 'raw_reasoning_details') {
      const reasoning = this.mode === 'raw_reasoning_content' ? raw.direct : raw.fromDetails
      const content = `${this.unknownCarry}${contentText}`
      this.unknownCarry = ''
      this.reasoningBuffer += reasoning
      return { content, reasoning }
    }

    if (this.mode === 'tagged') {
      return this.consumeTaggedText(`${this.unknownCarry}${contentText}`)
    }

    const probe = `${this.unknownCarry}${contentText}`
    const { stable, carry } = splitStableAndCarryTagText(probe)
    this.unknownCarry = carry
    return { content: stable, reasoning: '' }
  }

  flushPendingContent(): string {
    if (this.mode === 'tagged') {
      const extracted = this.consumeTaggedText(this.unknownCarry)
      this.unknownCarry = ''
      if (this.taggedBuffer) {
        if (this.taggedInThinking) {
          this.reasoningBuffer += this.taggedBuffer
        } else {
          extracted.content += this.taggedBuffer
        }
        this.taggedBuffer = ''
      }
      return extracted.content
    }

    const pending = this.unknownCarry
    this.unknownCarry = ''
    return pending
  }

  getReasoningContent(): string {
    return this.reasoningBuffer
  }

  private consumeTaggedText(input: string): { content: string; reasoning: string } {
    this.taggedBuffer += input
    let contentOut = ''
    let reasoningOut = ''
    let cursor = 0
    THINKING_TAG_SCAN_RE.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = THINKING_TAG_SCAN_RE.exec(this.taggedBuffer)) !== null) {
      const fullTag = match[0]
      const idx = match.index
      const before = this.taggedBuffer.slice(cursor, idx)
      const routed = this.routeTaggedSegment(before)
      contentOut += routed.content
      reasoningOut += routed.reasoning

      const parsed = parseReasoningTag(fullTag)
      if (parsed) {
        this.taggedInThinking = !parsed.closing
      } else {
        const passthrough = this.routeTaggedSegment(fullTag)
        contentOut += passthrough.content
        reasoningOut += passthrough.reasoning
      }

      cursor = idx + fullTag.length
    }

    const remainder = this.taggedBuffer.slice(cursor)
    const split = splitStableAndCarryTagText(remainder)
    const routedRemainder = this.routeTaggedSegment(split.stable)
    contentOut += routedRemainder.content
    reasoningOut += routedRemainder.reasoning
    this.taggedBuffer = split.carry
    this.reasoningBuffer += reasoningOut
    return { content: contentOut, reasoning: reasoningOut }
  }

  private routeTaggedSegment(segment: string): { content: string; reasoning: string } {
    if (!segment) return { content: '', reasoning: '' }
    if (this.taggedInThinking) {
      return { content: '', reasoning: segment }
    }
    return { content: segment, reasoning: '' }
  }
}

export function createStreamReasoningExtractor(): StreamReasoningExtractor {
  return new StreamReasoningExtractor()
}
