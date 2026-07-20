import {
  COMMAND_CAPTURE_MAX_UTF8_BYTES,
  type CommandCaptureMetadata,
  type CommandCaptureReason,
} from '@gyshell/shared'

type ProjectorState =
  | 'text'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'string-control'
  | 'string-control-escape'

const utf8Length = (value: string): number => Buffer.byteLength(value, 'utf8')

const normalizeScalar = (value: string): string => {
  const codePoint = value.codePointAt(0)
  if (
    codePoint !== undefined &&
    codePoint >= 0xd800 &&
    codePoint <= 0xdfff
  ) {
    return '\ufffd'
  }
  return value
}

const normalizeUnicodeScalars = (value: string): string => {
  let firstInvalid = -1
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
      } else {
        firstInvalid = index
        break
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      firstInvalid = index
      break
    }
  }
  if (firstInvalid === -1) return value

  const parts: string[] = [value.slice(0, firstInvalid)]
  let retainedStart = firstInvalid
  for (let index = firstInvalid; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1
        continue
      }
    } else if (codeUnit < 0xdc00 || codeUnit > 0xdfff) {
      continue
    }
    parts.push(value.slice(retainedStart, index), '\ufffd')
    retainedStart = index + 1
  }
  parts.push(value.slice(retainedStart))
  return parts.join('')
}

/**
 * Builds an append-only, readable transcript from a terminal byte stream.
 * Screen rewrites such as carriage returns and ANSI controls are represented
 * without mutating text that has already been exposed through a cursor.
 */
export class CommandTranscriptCapture {
  private readonly chunks: string[] = []
  private readonly maxUtf8Bytes: number
  private projectorState: ProjectorState = 'text'
  private pendingCarriageReturn = false
  private pendingHighSurrogate = ''
  private retainedUtf8Bytes = 0
  private observedUtf8Bytes = 0
  private newlineCount = 0
  private revision = 0
  private state: CommandCaptureMetadata['state'] = 'in_progress'
  private reason: CommandCaptureReason | undefined
  private terminalControlsObserved = false
  private retentionLimitReached = false
  private endsWithNewline = false
  private sealed = false

  constructor(maxUtf8Bytes = COMMAND_CAPTURE_MAX_UTF8_BYTES) {
    this.maxUtf8Bytes = Math.max(1, Math.floor(maxUtf8Bytes))
  }

  append(chunk: string): void {
    if (!chunk || this.sealed) {
      return
    }
    let completeInput = this.pendingHighSurrogate + chunk
    this.pendingHighSurrogate = ''
    const trailingCodeUnit = completeInput.charCodeAt(completeInput.length - 1)
    if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
      this.pendingHighSurrogate = completeInput.slice(-1)
      completeInput = completeInput.slice(0, -1)
    }
    const controlsObservedBeforeProjection = this.terminalControlsObserved
    const projected = this.project(completeInput)
    if (projected) {
      this.appendProjected(projected)
    } else if (
      this.terminalControlsObserved !== controlsObservedBeforeProjection
    ) {
      this.revision += 1
    }
  }

  seal(): void {
    if (this.sealed) {
      return
    }
    // Capture certainty and physical mutability are independent. An
    // incomplete/unknown capture still needs a hard end boundary so prompt or
    // hook bytes arriving later cannot mutate a previously returned prefix.
    this.sealed = true
    this.flushPendingHighSurrogate()
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false
      this.terminalControlsObserved = true
      this.appendProjected('\n')
    }
    if (this.projectorState !== 'text') {
      this.terminalControlsObserved = true
      this.projectorState = 'text'
      this.markIncomplete('projection_ambiguous')
    }
    if (this.state === 'in_progress') {
      this.state = 'complete'
    }
    if (this.chunks.length > 1) {
      const consolidated = this.chunks.join('')
      this.chunks.length = 0
      this.chunks.push(consolidated)
    }
    this.revision += 1
  }

  markIncomplete(reason: CommandCaptureReason, observedUtf8Bytes?: number): void {
    if (reason === 'retention_limit') {
      this.retentionLimitReached = true
    }
    if (this.state === 'complete' || this.state === 'unknown') {
      return
    }
    const previousObservedUtf8Bytes = this.observedUtf8Bytes
    if (observedUtf8Bytes !== undefined && Number.isFinite(observedUtf8Bytes)) {
      this.observedUtf8Bytes = Math.max(
        this.observedUtf8Bytes,
        Math.max(0, Math.floor(observedUtf8Bytes))
      )
    }
    if (this.state === 'incomplete') {
      if (this.observedUtf8Bytes !== previousObservedUtf8Bytes) {
        this.revision += 1
      }
      return
    }
    this.state = 'incomplete'
    this.reason = reason
    this.revision += 1
  }

  markUnknown(reason: CommandCaptureReason, observedUtf8Bytes?: number): void {
    const previousObservedUtf8Bytes = this.observedUtf8Bytes
    if (observedUtf8Bytes !== undefined && Number.isFinite(observedUtf8Bytes)) {
      this.observedUtf8Bytes = Math.max(
        this.observedUtf8Bytes,
        Math.max(0, Math.floor(observedUtf8Bytes))
      )
    }
    if (this.state === 'complete' || this.state === 'unknown') {
      if (this.observedUtf8Bytes !== previousObservedUtf8Bytes) {
        this.revision += 1
      }
      return
    }
    this.flushPendingHighSurrogate()
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false
      this.terminalControlsObserved = true
      this.appendProjected('\n')
    }
    if (this.projectorState !== 'text') {
      this.terminalControlsObserved = true
      this.projectorState = 'text'
    }
    // "Incomplete" proves a specific loss (for example, a retention cap),
    // while "unknown" means the protocol cannot prove the attribution or
    // boundaries of the retained transcript at all. The latter is the
    // stronger statement. Keep observed/retained byte counts so callers can
    // still see any known retention loss after this promotion.
    this.state = 'unknown'
    this.reason = reason
    this.revision += 1
  }

  markTerminalControlsObserved(): void {
    if (this.terminalControlsObserved) {
      return
    }
    this.terminalControlsObserved = true
    this.revision += 1
  }

  getText(): string {
    return this.chunks.join('')
  }

  getMetadata(): CommandCaptureMetadata {
    const availableLineCount =
      this.retainedUtf8Bytes === 0
        ? 0
        : this.newlineCount + (this.endsWithNewline ? 0 : 1)
    return {
      state: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      observedUtf8Bytes: this.observedUtf8Bytes,
      retainedUtf8Bytes: this.retainedUtf8Bytes,
      availableLineCount,
      revision: this.revision,
      terminalControlsObserved: this.terminalControlsObserved,
    }
  }

  private appendProjected(value: string): void {
    const normalized = normalizeUnicodeScalars(value)
    const valueBytes = utf8Length(normalized)
    const revisionBeforeAppend = this.revision
    this.observedUtf8Bytes += valueBytes

    if (this.retentionLimitReached) {
      if (valueBytes > 0 && this.revision === revisionBeforeAppend) {
        this.revision += 1
      }
      return
    }

    const remaining = this.maxUtf8Bytes - this.retainedUtf8Bytes
    if (remaining <= 0) {
      if (valueBytes > 0) {
        this.markIncomplete('retention_limit')
        if (this.revision === revisionBeforeAppend) {
          this.revision += 1
        }
      }
      return
    }

    let retained = normalized
    if (valueBytes > remaining) {
      retained = this.takeUtf8Prefix(normalized, remaining)
      this.markIncomplete('retention_limit')
    }
    if (!retained) {
      return
    }

    this.chunks.push(retained)
    const retainedBytes = utf8Length(retained)
    this.retainedUtf8Bytes += retainedBytes
    for (
      let newlineIndex = retained.indexOf('\n');
      newlineIndex !== -1;
      newlineIndex = retained.indexOf('\n', newlineIndex + 1)
    ) {
      this.newlineCount += 1
    }
    this.endsWithNewline = retained.endsWith('\n')
    this.revision += 1
  }

  private flushPendingHighSurrogate(): void {
    if (!this.pendingHighSurrogate) {
      return
    }
    const pending = this.pendingHighSurrogate
    this.pendingHighSurrogate = ''
    const projected = this.project(pending)
    if (projected) {
      this.appendProjected(projected)
    }
  }

  private takeUtf8Prefix(value: string, byteLimit: number): string {
    if (byteLimit <= 0) {
      return ''
    }
    let bytes = 0
    let end = 0
    for (const rawScalar of value) {
      const scalar = normalizeScalar(rawScalar)
      const scalarBytes = utf8Length(scalar)
      if (bytes + scalarBytes > byteLimit) {
        break
      }
      end += rawScalar.length
      bytes += scalarBytes
    }
    return value.slice(0, end)
  }

  private project(chunk: string): string {
    if (
      this.projectorState === 'text' &&
      !this.pendingCarriageReturn &&
      !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(chunk)
    ) {
      return chunk
    }
    let result = ''
    const appendText = (value: string): void => {
      if (this.pendingCarriageReturn) {
        this.pendingCarriageReturn = false
        if (value === '\n') {
          result += '\n'
          return
        }
        this.terminalControlsObserved = true
        result += '\n'
      }
      result += value
    }

    for (const rawScalar of chunk) {
      const scalar = normalizeScalar(rawScalar)
      const codePoint = scalar.codePointAt(0) ?? 0

      if (this.projectorState === 'text') {
        if (scalar === '\r') {
          // PTYs can emit CRCRLF at arbitrary chunk boundaries. Repeated
          // carriage returns without printable content do not represent an
          // additional log record, so keep one pending delimiter.
          this.pendingCarriageReturn = true
        } else if (scalar === '\n') {
          appendText('\n')
        } else if (scalar === '\x1b') {
          if (this.pendingCarriageReturn) {
            result += '\n'
            this.pendingCarriageReturn = false
            this.terminalControlsObserved = true
          }
          this.projectorState = 'escape'
          this.terminalControlsObserved = true
        } else if (scalar === '\u009b') {
          this.projectorState = 'csi'
          this.terminalControlsObserved = true
        } else if (scalar === '\u009d') {
          this.projectorState = 'osc'
          this.terminalControlsObserved = true
        } else if (
          scalar === '\u0090' ||
          scalar === '\u0098' ||
          scalar === '\u009e' ||
          scalar === '\u009f'
        ) {
          this.projectorState = 'string-control'
          this.terminalControlsObserved = true
        } else if (scalar === '\t' || (codePoint >= 0x20 && codePoint !== 0x7f)) {
          if (codePoint >= 0x80 && codePoint <= 0x9f) {
            this.terminalControlsObserved = true
          } else {
            appendText(scalar)
          }
        } else {
          this.terminalControlsObserved = true
        }
        continue
      }

      this.terminalControlsObserved = true
      if (this.projectorState === 'escape') {
        if (scalar === '[') {
          this.projectorState = 'csi'
        } else if (scalar === ']') {
          this.projectorState = 'osc'
        } else if (scalar === 'P' || scalar === '^' || scalar === '_' || scalar === 'X') {
          this.projectorState = 'string-control'
        } else if (codePoint >= 0x20 && codePoint <= 0x2f) {
          // ISO-2022 and ECMA-48 escape sequences may contain one or more
          // intermediate bytes before their final byte (for example ESC ( B,
          // emitted by common terminfo sgr0 capabilities). Keep consuming the
          // whole sequence instead of leaking its final byte as transcript.
          this.projectorState = 'escape-intermediate'
        } else {
          this.projectorState = 'text'
        }
      } else if (this.projectorState === 'escape-intermediate') {
        if (codePoint >= 0x20 && codePoint <= 0x2f) {
          // More intermediate bytes remain part of the same escape.
        } else if (codePoint >= 0x30 && codePoint <= 0x7e) {
          this.projectorState = 'text'
        } else if (scalar === '\x1b') {
          this.projectorState = 'escape'
        } else {
          this.projectorState = 'text'
        }
      } else if (this.projectorState === 'csi') {
        if (scalar === '\x18' || scalar === '\x1a') {
          // CAN and SUB cancel an in-flight control sequence. The next byte
          // is ordinary terminal input and must not be consumed as its final.
          this.projectorState = 'text'
        } else if (scalar === '\x1b') {
          // ESC cancels the current CSI and introduces a new escape sequence.
          this.projectorState = 'escape'
        } else if (codePoint >= 0x40 && codePoint <= 0x7e) {
          this.projectorState = 'text'
        }
      } else if (this.projectorState === 'osc') {
        if (scalar === '\x07' || scalar === '\u009c') {
          this.projectorState = 'text'
        } else if (scalar === '\x1b') {
          this.projectorState = 'osc-escape'
        }
      } else if (this.projectorState === 'osc-escape') {
        this.projectorState = scalar === '\\' ? 'text' : 'osc'
      } else if (this.projectorState === 'string-control') {
        if (scalar === '\u009c') {
          this.projectorState = 'text'
        } else if (scalar === '\x1b') {
          this.projectorState = 'string-control-escape'
        }
      } else if (this.projectorState === 'string-control-escape') {
        this.projectorState = scalar === '\\' ? 'text' : 'string-control'
      }
    }
    return result
  }
}
