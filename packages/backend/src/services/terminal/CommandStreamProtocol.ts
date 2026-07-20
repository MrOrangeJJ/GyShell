import { Buffer } from 'node:buffer'

const GYSHELL_OSC_INTRODUCER = '\x1b]1337;'
const LEGACY_GYSHELL_MARKER_PREFIX = 'gyshell_'
const COMMAND_PROTOCOL_TOKEN_PATTERN = /^[0-9a-f]{32}$/
const MAX_PROTOCOL_MARKER_LENGTH = 16 * 1024
const INITIALIZATION_READY_MARKER_PREFIX = '__GYSHELL_READY__'

/**
 * Builds a per-runtime marker used only while a backend is consuming shell
 * initialization output. Runtime scoping prevents an unrelated banner from
 * being mistaken for the completion of the current bootstrap.
 */
export const buildInitializationReadyMarker = (
  runtimeToken?: string,
  attempt?: number
): string => {
  if (runtimeToken === undefined) {
    if (attempt !== undefined) {
      throw new Error('Initialization attempt requires a runtime token')
    }
    return INITIALIZATION_READY_MARKER_PREFIX
  }
  if (!COMMAND_PROTOCOL_TOKEN_PATTERN.test(runtimeToken)) {
    throw new Error('Invalid command protocol runtime token')
  }
  const runtimeMarker = `${INITIALIZATION_READY_MARKER_PREFIX}:${runtimeToken}`
  if (attempt === undefined) return runtimeMarker
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error('Invalid shell initialization attempt')
  }
  return `${runtimeMarker}:${attempt}`
}

/**
 * Locates a ready marker only when it is framed as a complete terminal line.
 * Shell echo or tracing may contain the marker text, but not as the isolated
 * protocol record emitted by the bootstrap.
 */
export const findInitializationReadyMarkerLine = (
  buffer: string,
  marker: string
): number => {
  if (!marker) return -1
  let searchOffset = 0
  while (searchOffset < buffer.length) {
    const markerOffset = buffer.indexOf(marker, searchOffset)
    if (markerOffset < 0) return -1
    const preceding = buffer[markerOffset - 1]
    const following = buffer[markerOffset + marker.length]
    if (
      (preceding === '\r' || preceding === '\n') &&
      (following === '\r' || following === '\n')
    ) {
      return markerOffset
    }
    searchOffset = markerOffset + 1
  }
  return -1
}

/**
 * Consumes exactly the first complete expected marker line from an
 * initialization buffer. Bytes after it are ordinary terminal data,
 * including any later text that happens to contain the same marker literal.
 */
export const consumeInitializationReadyMarker = (
  buffer: string,
  marker: string
): string | undefined => {
  const markerOffset = findInitializationReadyMarkerLine(buffer, marker)
  return markerOffset === -1
    ? undefined
    : buffer.slice(markerOffset + marker.length)
}

/**
 * Returns the marker namespace shared by a runtime's shell hooks and parser.
 * Omitting the token intentionally preserves the legacy namespace for fake
 * backends and protocol tests that do not model a real shell runtime.
 */
export const buildCommandProtocolMarkerPrefix = (runtimeToken?: string): string => {
  if (runtimeToken === undefined) {
    return LEGACY_GYSHELL_MARKER_PREFIX
  }
  if (!COMMAND_PROTOCOL_TOKEN_PATTERN.test(runtimeToken)) {
    throw new Error('Invalid command protocol runtime token')
  }
  return `gyshell_${runtimeToken}_`
}

export const buildUnixCommandDispatcherName = (runtimeToken: string): string => {
  buildCommandProtocolMarkerPrefix(runtimeToken)
  return `__gyshell_${runtimeToken}_dispatch`
}

export const buildUnixCommandCompletionName = (runtimeToken: string): string =>
  `${buildUnixCommandDispatcherName(runtimeToken)}_complete`

const quotePosixShellLiteral = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`

const encodePosixPrintfBPayload = (value: string): string =>
  Array.from(value, (scalar) => {
    const codePoint = scalar.codePointAt(0)!
    if (scalar === '\\') return '\\x5c'
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return Buffer.from(scalar, 'utf8')
        .toString('hex')
        .replace(/../g, (byte) => `\\x${byte}`)
    }
    return scalar
  }).join('')

/**
 * Builds one interactive input unit without moving the user command into a
 * function scope. The dispatcher stores only the command text; `eval` itself
 * remains at the interactive shell's top level, so declarations, positional
 * parameters, `local`, and `return` keep their native shell semantics.
 */
export const buildUnixDispatchedCommand = (
  runtimeToken: string,
  expectedSequence: number,
  requestNonce: string,
  command: string
): string => {
  if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1) {
    throw new Error('Invalid command protocol sequence')
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestNonce)) {
    throw new Error('Invalid command protocol request nonce')
  }
  const privatePrefix = `__gyshell_${runtimeToken}`
  const dispatcherName = buildUnixCommandDispatcherName(runtimeToken)
  const completionName = buildUnixCommandCompletionName(runtimeToken)
  const restoreName = `${dispatcherName}_restore`
  const startName = `${dispatcherName}_start`
  const debugPrepareName = `${dispatcherName}_prepare_debug`
  const payloadName = `${privatePrefix}_dispatch_payload`
  const savedExitName = `${privatePrefix}_command_exit`
  const debugTrapFileName = `${privatePrefix}_dispatch_debug_trap_file`
  const debugFilterName = `${privatePrefix}_dispatch_debug_filter`
  const debugRestoringName = `${privatePrefix}_dispatch_debug_restoring`
  const debugRestoreCommandName = `${privatePrefix}_dispatch_debug_restore_command`
  return [
    `${dispatcherName} "$?" ${expectedSequence} ${requestNonce} ${quotePosixShellLiteral(encodePosixPrintfBPayload(command))}`,
    `[ -z "$BASH_VERSION" ] || builtin trap -p DEBUG > "$${debugTrapFileName}"`,
    '[ -z "$BASH_VERSION" ] || builtin trap - DEBUG',
    `[ -z "$BASH_VERSION" ] || ${debugPrepareName}`,
    `[ -z "$BASH_VERSION" ] || builtin trap '${debugFilterName} "$?"' DEBUG`,
    `${startName} ${expectedSequence} ${requestNonce}`,
    restoreName,
    `builtin eval -- "$${payloadName}"`,
    `${completionName} "$?" ${expectedSequence} ${requestNonce}`,
    `[ -z "$BASH_VERSION" ] || ${debugRestoringName}=1`,
    `[ -z "$BASH_VERSION" ] || builtin eval -- "$${debugRestoreCommandName}"`,
    `${restoreName} "$${savedExitName}"`,
  ].join('; ')
}

/**
 * Installs the runtime-private bookends used by exec_command. The command is
 * deliberately evaluated by the top-level input unit built above, not by
 * either function. The completion bookend restores only GyShell's hidden
 * prompt hooks around the user's current hook state; the final hidden prompt
 * hook therefore remains the authoritative ready boundary even when the
 * command replaces PROMPT_COMMAND/precmd_functions.
 */
export const buildUnixCommandDispatcherScript = (
  runtimeToken: string
): string => {
  const markerPrefix = buildCommandProtocolMarkerPrefix(runtimeToken)
  const privatePrefix = `__gyshell_${runtimeToken}`
  const dispatcherName = buildUnixCommandDispatcherName(runtimeToken)
  const completionName = buildUnixCommandCompletionName(runtimeToken)
  const restoreName = `${dispatcherName}_restore`
  const startName = `${dispatcherName}_start`
  const debugPrepareName = `${dispatcherName}_prepare_debug`
  const precmdBeginHookName = `${privatePrefix}_precmd_begin`
  const precmdHookName = `${privatePrefix}_precmd`
  const historyHookName = `${privatePrefix}_history`
  const sequenceName = `${privatePrefix}_command_seq`
  const nonceName = `${privatePrefix}_command_nonce`
  const inCommandName = `${privatePrefix}_in_command`
  const savedPromptEolName = `${privatePrefix}_saved_prompt_eol_mark`
  const savedExitName = `${privatePrefix}_command_exit`
  const expectedName = `${privatePrefix}_dispatch_expected`
  const fallbackName = `${privatePrefix}_dispatch_fallback`
  const priorInputName = `${privatePrefix}_dispatch_prior_input`
  const priorExitName = `${privatePrefix}_dispatch_prior_exit`
  const parseExitName = `${privatePrefix}_dispatch_parse_exit`
  const parseArgumentName = `${privatePrefix}_dispatch_parse_argument`
  const inputName = `${privatePrefix}_dispatch_input`
  const payloadName = `${privatePrefix}_dispatch_payload`
  const dispatchExitName = `${privatePrefix}_dispatch_exit`
  const dispatchActiveName = `${privatePrefix}_dispatch_active`
  const completionReadyName = `${privatePrefix}_dispatch_completion_ready`
  const savedDebugTrapName = `${privatePrefix}_dispatch_saved_debug_trap`
  const savedDebugBodyName = `${privatePrefix}_dispatch_saved_debug_body`
  const quotedDebugTrapName = `${privatePrefix}_dispatch_quoted_debug_trap`
  const debugTrapFileName = `${privatePrefix}_dispatch_debug_trap_file`
  const debugFilterName = `${privatePrefix}_dispatch_debug_filter`
  const debugPriorName = `${privatePrefix}_dispatch_debug_prior`
  const debugRestoringName = `${privatePrefix}_dispatch_debug_restoring`
  const debugRestoreCommandName = `${privatePrefix}_dispatch_debug_restore_command`
  const savedIntTrapName = `${privatePrefix}_dispatch_saved_int_trap`
  const currentIntTrapName = `${privatePrefix}_dispatch_current_int_trap`
  const interruptName = `${dispatcherName}_interrupt`
  const replayIntTrapName = `${privatePrefix}_dispatch_replay_int_trap`
  const cleanPromptCommandsName = `${privatePrefix}_dispatch_prompt_commands`
  const promptCommandItemName = `${privatePrefix}_dispatch_prompt_command_item`
  const historyPattern = `${dispatcherName} *`
  return [
    `${historyHookName}() {`,
    `  if [ -n "\${ZSH_VERSION-}" ] && [[ "\${1-}" == "${dispatcherName} "* ]]; then return 1; fi`,
    '  return 0',
    '}',
    `${debugTrapFileName}="\${TMPDIR:-/tmp}/${privatePrefix}-debug-trap-$$"`,
    `${debugPrepareName}() {`,
    `  ${savedDebugTrapName}="$(<"$${debugTrapFileName}")"`,
    `  command rm -f -- "$${debugTrapFileName}" 2>/dev/null || true`,
    `  ${savedDebugBodyName}=`,
    `  ${debugRestoreCommandName}=`,
    `  case "$${savedDebugTrapName}" in`,
    `    trap\\ --\\ *\\ DEBUG)`,
    `      ${quotedDebugTrapName}="\${${savedDebugTrapName}#trap -- }"`,
    `      ${quotedDebugTrapName}="\${${quotedDebugTrapName}% DEBUG}"`,
    `      builtin eval -- "${savedDebugBodyName}=$${quotedDebugTrapName}"`,
    `      ${debugRestoreCommandName}="$${savedDebugTrapName}"`,
    `      ;;`,
    `  esac`,
    `  if [ "$${savedDebugBodyName}" = "${privatePrefix}_preexec" ]; then ${savedDebugBodyName}=; fi`,
    `  if [ -z "$${debugRestoreCommandName}" ]; then`,
    `    if shopt -q extdebug; then ${debugRestoreCommandName}='builtin trap - DEBUG'; else ${debugRestoreCommandName}="builtin trap '${privatePrefix}_preexec' DEBUG"; fi`,
    `  fi`,
    `  ${debugRestoringName}=0`,
    '}',
    `${debugFilterName}() {`,
    `  local ${debugPriorName}="$1"`,
    `  if [ "\${${debugRestoringName}-0}" = 1 ]; then return 0; fi`,
    `  case "\${FUNCNAME[1]-}" in ${dispatcherName}|${startName}|${restoreName}|${completionName}|${interruptName}|${precmdBeginHookName}|${precmdHookName}) return 0 ;; esac`,
    `  case "\${BASH_COMMAND-}" in *${privatePrefix}_dispatch*) return 0 ;; esac`,
    `  [ -n "\${${savedDebugBodyName}-}" ] || return 0`,
    `  ${restoreName} "$${debugPriorName}"`,
    `  builtin eval -- "$${savedDebugBodyName}"`,
    '}',
    `${dispatcherName}() {`,
    `  local ${priorInputName}="$1" ${expectedName}="$2" ${fallbackName}="$3" ${inputName}="$4"`,
    `  case "$${priorInputName}" in ''|*[!0-9]*) ${priorInputName}=0 ;; esac`,
    `  ${priorInputName}=$(( $${priorInputName} & 255 ))`,
    `  ${dispatchActiveName}=1`,
    `  ${completionReadyName}=0`,
    `  builtin printf -v ${payloadName} '%b' "$${inputName}"`,
    `  ${priorExitName}="$${priorInputName}"`,
    `  ${parseExitName}=0`,
    `  ${savedIntTrapName}="$(builtin trap -p INT)"`,
    `  builtin trap '${interruptName}' INT`,
    `  ${sequenceName}="$${expectedName}"`,
    `  ${nonceName}="$${fallbackName}"`,
    `  ${inCommandName}=1`,
    '  if [ -n "${ZSH_VERSION-}" ]; then',
    `    ${savedPromptEolName}=\${PROMPT_EOL_MARK-}`,
    `    PROMPT_EOL_MARK="$(builtin printf "\\033]1337;${markerPrefix}preend;seq=%s;nonce=%s\\007" "$${expectedName}" "$${fallbackName}")$${savedPromptEolName}"`,
    `    builtin print -s -- "$${payloadName}" 2>/dev/null || true`,
    '  elif [ -n "${BASH_VERSION-}" ]; then',
    `    builtin history -s "$${payloadName}" 2>/dev/null || true`,
    `    if shopt -q extglob; then BASH_ENV= "$BASH" --noprofile --norc -O extglob -n <<< "$${payloadName}" 2>/dev/null || ${parseExitName}=$?; else BASH_ENV= "$BASH" --noprofile --norc -n <<< "$${payloadName}" 2>/dev/null || ${parseExitName}=$?; fi`,
    '  fi',
    '}',
    `${startName}() {`,
    `  local ${expectedName}="$1" ${fallbackName}="$2"`,
    `  builtin printf "\\033]1337;${markerPrefix}preexec;seq=%s;nonce=%s\\007" "$${expectedName}" "$${fallbackName}"`,
    '}',
    `${restoreName}() {`,
    `  return "\${1-\${${priorExitName}-0}}"`,
    '}',
    `${completionName}() {`,
    `  local ${dispatchExitName}="$1" ${expectedName}="$2" ${fallbackName}="$3" ${parseArgumentName}="\${${parseExitName}-0}"`,
    `  if [ "$${dispatchExitName}" = 0 ] && [ "$${parseArgumentName}" != 0 ]; then ${dispatchExitName}="$${parseArgumentName}"; fi`,
    `  ${savedExitName}="$${dispatchExitName}"`,
    `  ${completionReadyName}=1`,
    '  if [ -n "${BASH_VERSION-}" ]; then',
    `    builtin printf "\\033]1337;${markerPrefix}preend;seq=%s;nonce=%s\\007" "$${expectedName}" "$${fallbackName}"`,
    '  fi',
    `  unset ${payloadName} ${privatePrefix}_dispatch_prior_exit ${parseExitName}`,
    `  ${sequenceName}="$${expectedName}"`,
    `  ${nonceName}="$${fallbackName}"`,
    `  ${inCommandName}=1`,
    '  if [ -n "${ZSH_VERSION-}" ]; then',
    `    autoload -Uz add-zsh-hook 2>/dev/null || true`,
    `    add-zsh-hook zshaddhistory ${historyHookName} 2>/dev/null || true`,
    `    precmd_functions=(${precmdBeginHookName} \${precmd_functions:#${precmdBeginHookName}})`,
    `    precmd_functions=(\${precmd_functions:#${precmdHookName}} ${precmdHookName})`,
    '  elif [ -n "${BASH_VERSION-}" ]; then',
    `    case ":\${HISTIGNORE-}:" in *":${historyPattern}:"*) ;; *) HISTIGNORE="\${HISTIGNORE:+$HISTIGNORE:}${historyPattern}" ;; esac`,
    `    if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then`,
    `      ${cleanPromptCommandsName}=()`,
    `      for ${promptCommandItemName} in "\${PROMPT_COMMAND[@]}"; do`,
    `        case "$${promptCommandItemName}" in ${precmdBeginHookName}|${precmdHookName}) ;; *) ${cleanPromptCommandsName}+=("$${promptCommandItemName}") ;; esac`,
    '      done',
    `      PROMPT_COMMAND=(${precmdBeginHookName} "\${${cleanPromptCommandsName}[@]}" ${precmdHookName})`,
    `      unset ${cleanPromptCommandsName} ${promptCommandItemName}`,
    '    else',
    `      ${cleanPromptCommandsName}="\${PROMPT_COMMAND-}"`,
    `      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}//${precmdBeginHookName}; /}"`,
    `      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}//; ${precmdBeginHookName}/}"`,
    `      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}//${precmdHookName}; /}"`,
    `      ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}//; ${precmdHookName}/}"`,
    `      while [[ "$${cleanPromptCommandsName}" == "${precmdBeginHookName}; "* ]]; do ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}#${precmdBeginHookName}; }"; done`,
    `      while [[ "$${cleanPromptCommandsName}" == *"; ${precmdHookName}" ]]; do ${cleanPromptCommandsName}="\${${cleanPromptCommandsName}%; ${precmdHookName}}"; done`,
    `      [ "$${cleanPromptCommandsName}" = "${precmdBeginHookName}" ] && ${cleanPromptCommandsName}=`,
    `      [ "$${cleanPromptCommandsName}" = "${precmdHookName}" ] && ${cleanPromptCommandsName}=`,
    `      PROMPT_COMMAND="${precmdBeginHookName}\${${cleanPromptCommandsName}:+; $${cleanPromptCommandsName}}; ${precmdHookName}"`,
    `      unset ${cleanPromptCommandsName}`,
    '    fi',
    '  fi',
    `  ${currentIntTrapName}="$(builtin trap -p INT)"`,
    `  case "$${currentIntTrapName}" in *${interruptName}*) builtin trap - INT; if [ -n "\${${savedIntTrapName}-}" ]; then builtin eval -- "$${savedIntTrapName}"; fi ;; esac`,
    `  unset ${savedIntTrapName} ${currentIntTrapName}`,
    `  return "$${dispatchExitName}"`,
    '}',
    `${interruptName}() {`,
    `  local ${replayIntTrapName}="\${${savedIntTrapName}-}"`,
    `  ${completionName} 130 "\${${sequenceName}-0}" "\${${nonceName}-interrupted}"`,
    `  if [ -n "$${replayIntTrapName}" ]; then command kill -s INT "$$"; fi`,
    '  return 130',
    '}',
    'if [ -n "${ZSH_VERSION-}" ]; then',
    '  autoload -Uz add-zsh-hook 2>/dev/null || true',
    `  add-zsh-hook zshaddhistory ${historyHookName} 2>/dev/null || true`,
    'elif [ -n "${BASH_VERSION-}" ]; then',
    `  case ":\${HISTIGNORE-}:" in *":${historyPattern}:"*) ;; *) HISTIGNORE="\${HISTIGNORE:+$HISTIGNORE:}${historyPattern}" ;; esac`,
    'fi',
  ].join('\n')
}

export interface GyShellBoundaryMarker {
  kind: 'preexec' | 'preend' | 'precmd'
  sequence?: number
  nonce?: string
  exitCode?: number
  cwdBase64?: string
  homeBase64?: string
  legacy: boolean
}

export type CommandStreamProtocolEvent =
  | { type: 'text'; text: string }
  | { type: 'marker'; marker: GyShellBoundaryMarker }
  | { type: 'malformed-marker' }

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^-?\d+$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

const parseMarker = (body: string): GyShellBoundaryMarker | null => {
  const [kind, ...parts] = body.split(';')
  if (kind !== 'preexec' && kind !== 'preend' && kind !== 'precmd') {
    return null
  }

  const fields = new Map<string, string>()
  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator <= 0) {
      continue
    }
    fields.set(part.slice(0, separator), part.slice(separator + 1))
  }

  const sequence = parseInteger(fields.get('seq'))
  const nonce = fields.get('nonce')
  // The initial prompt has seq=0 but no command nonce yet. Treat its explicit
  // empty field as a legacy/idle marker; only non-empty nonces must satisfy
  // the modern boundary format.
  if (nonce !== undefined && nonce !== '' && !/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) {
    return null
  }
  const exitCode = parseInteger(fields.get('ec'))
  return {
    kind,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(nonce ? { nonce } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(fields.has('cwd_b64') ? { cwdBase64: fields.get('cwd_b64') } : {}),
    ...(fields.has('home_b64') ? { homeBase64: fields.get('home_b64') } : {}),
    legacy: sequence === undefined || !nonce,
  }
}

/** Removes GyShell OSC protocol frames while preserving event ordering. */
export class CommandStreamProtocol {
  private buffer = ''
  private readonly oscPrefix: string

  constructor(runtimeToken?: string) {
    this.oscPrefix = GYSHELL_OSC_INTRODUCER + buildCommandProtocolMarkerPrefix(runtimeToken)
  }

  feed(chunk: string): CommandStreamProtocolEvent[] {
    if (chunk) {
      this.buffer += chunk
    }
    const events: CommandStreamProtocolEvent[] = []

    while (this.buffer) {
      const markerStart = this.buffer.indexOf(this.oscPrefix)
      if (markerStart === -1) {
        const trailingPrefixLength = this.getTrailingPrefixLength(this.buffer)
        const flushLength = this.buffer.length - trailingPrefixLength
        if (flushLength > 0) {
          events.push({ type: 'text', text: this.buffer.slice(0, flushLength) })
          this.buffer = this.buffer.slice(flushLength)
        }
        break
      }

      if (markerStart > 0) {
        events.push({ type: 'text', text: this.buffer.slice(0, markerStart) })
        this.buffer = this.buffer.slice(markerStart)
        continue
      }

      const belIndex = this.buffer.indexOf('\x07', this.oscPrefix.length)
      const stIndex = this.buffer.indexOf('\x1b\\', this.oscPrefix.length)
      const markerEnd =
        belIndex === -1
          ? stIndex
          : stIndex === -1
            ? belIndex
            : Math.min(belIndex, stIndex)
      if (markerEnd === -1) {
        if (this.buffer.length > MAX_PROTOCOL_MARKER_LENGTH) {
          this.buffer = ''
          events.push({ type: 'malformed-marker' })
        }
        break
      }

      const terminatorLength = markerEnd === stIndex ? 2 : 1
      if (markerEnd > MAX_PROTOCOL_MARKER_LENGTH) {
        events.push({ type: 'malformed-marker' })
        this.buffer = this.buffer.slice(markerEnd + terminatorLength)
        continue
      }
      const body = this.buffer.slice(this.oscPrefix.length, markerEnd)
      const marker = parseMarker(body)
      events.push(marker ? { type: 'marker', marker } : { type: 'malformed-marker' })
      this.buffer = this.buffer.slice(markerEnd + terminatorLength)
    }

    return events
  }

  end(): CommandStreamProtocolEvent[] {
    if (!this.buffer) {
      return []
    }
    const pending = this.buffer
    this.buffer = ''
    if (pending.startsWith(this.oscPrefix)) {
      return [{ type: 'malformed-marker' }]
    }
    return [{ type: 'text', text: pending }]
  }

  private getTrailingPrefixLength(value: string): number {
    const upperBound = Math.min(value.length, this.oscPrefix.length - 1)
    for (let length = upperBound; length > 0; length -= 1) {
      if (value.endsWith(this.oscPrefix.slice(0, length))) {
        return length
      }
    }
    return 0
  }
}
