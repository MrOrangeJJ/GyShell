import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from '@gyshell/shared'

export const WINDOWS_PROMPT_MARKER_PREFIX = '__GYSHELL_PROMPT__::'
// Sidecar readiness is emitted from the first naturally rendered prompt only
// after that prompt has durably appended this sequence to its journal.
export const WINDOWS_POWERSHELL_INITIAL_PROMPT_SEQUENCE = 1
export const WINDOWS_POWERSHELL_SIDECAR_BUILD_THRESHOLD = 17763
export const WINDOWS_POWERSHELL_LOCAL_SIDECAR_DIR_PREFIX = 'gyshell-winps-'
export const WINDOWS_POWERSHELL_REMOTE_SIDECAR_DIR_NAME = 'GyShell/prompt-markers'
export const WINDOWS_POWERSHELL_SIDECAR_RETENTION_MS = 24 * 60 * 60 * 1000
export const WINDOWS_POWERSHELL_COMMAND_REQUEST_FILE_PREFIX = 'gyshell-request-'
export const WINDOWS_POWERSHELL_COMMAND_OUTPUT_FILE_PREFIX = 'gyshell-output-'
export const WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES = 16 * 1024
export const WINDOWS_POWERSHELL_FORMAT_WIDTH_FALLBACK = 120
export const WINDOWS_POWERSHELL_FORMAT_WIDTH_MIN = 40
export const WINDOWS_POWERSHELL_FORMAT_WIDTH_MAX = 4096

const WINDOWS_POWERSHELL_DISPATCH_VARIABLE = '__GyShell_InternalDispatch'
const WINDOWS_POWERSHELL_OUTCOME_RECORDER_VARIABLE = '__GyShell_InternalRecordOutcome'
const WINDOWS_POWERSHELL_USER_BLOCK_VARIABLE = '__GyShell_InternalUserCommandBlock'
const WINDOWS_POWERSHELL_INITIALIZATION_READY_VARIABLE_SUFFIX =
  'initialization_ready_marker'

export type WindowsCommandTrackingMode = 'shell-integration' | 'windows-powershell-sidecar'
export type WindowsPowerShellDispatchRequestKind = 'probe' | 'command'

export interface WindowsPromptMarkerState {
  sequence: number
  exitCode?: number
  outcomeKnown?: boolean
  requestId?: string
  outputObservedUtf8Bytes?: number
  outputRetainedUtf8Bytes?: number
  outputTruncated?: boolean
  outputCaptureFailed?: boolean
  cwd?: string
  homeDir?: string
  modifiedAtMs?: number
}

export const parseWindowsBuildNumber = (release: string | undefined): number | undefined => {
  const match = String(release || '').match(/^\d+\.\d+\.(\d+)/)
  if (!match) {
    return undefined
  }
  const build = Number.parseInt(match[1], 10)
  return Number.isFinite(build) ? build : undefined
}

export const shouldUseWindowsPowerShellSidecar = (options: {
  buildNumber?: number
  shell?: string
  trackingChannelAvailable: boolean
}): boolean => {
  if (!options.trackingChannelAvailable) {
    return false
  }
  const shell = String(options.shell || '').trim().toLowerCase()
  return shell.includes('powershell') || shell.includes('pwsh')
}

export const escapePowerShellSingleQuotedString = (value: string): string =>
  value.replace(/'/g, "''")

export const buildWindowsPowerShellInitializationReadyVariableName = (
  runtimeToken: string
): string => {
  if (!/^[a-f0-9]{32}$/i.test(runtimeToken)) {
    throw new Error('Invalid Windows PowerShell initialization runtime token.')
  }
  return `__gyshell_${runtimeToken.toLowerCase()}_${WINDOWS_POWERSHELL_INITIALIZATION_READY_VARIABLE_SUFFIX}`
}

export const buildWindowsPowerShellInitializationRetryCommand = (
  runtimeToken: string,
  readySequence: string,
  bootstrapPath: string
): string => {
  const normalizedToken = runtimeToken.toLowerCase()
  const readyVariable = buildWindowsPowerShellInitializationReadyVariableName(
    normalizedToken
  )
  const pendingVariable = `__gyshell_${normalizedToken}_pending_ready_sequence`
  const installedVariable = `__gyshell_${normalizedToken}_bootstrap_installed`
  const promptSequenceVariable = `__gyshell_${normalizedToken}_prompt_seq`
  const encodedReadySequence = Buffer.from(readySequence, 'utf8').toString(
    'base64'
  )
  const encodedBootstrapPath = Buffer.from(bootstrapPath, 'utf8').toString(
    'base64'
  )
  return (
    `$global:${readyVariable}=[Text.Encoding]::UTF8.GetString(` +
    `[Convert]::FromBase64String('${encodedReadySequence}'));` +
    `if($global:${installedVariable} -eq $true){` +
    `$global:${promptSequenceVariable}=0;` +
    `Clear-Host;` +
    `$global:${pendingVariable}=[string]$global:${readyVariable}}else{` +
    `$__gyshell_retry_bootstrap_path=[Text.Encoding]::UTF8.GetString(` +
    `[Convert]::FromBase64String('${encodedBootstrapPath}'));` +
    `. $__gyshell_retry_bootstrap_path}`
  )
}

export const buildWindowsPowerShellRequestMarkerPath = (
  promptMarkerPath: string,
  requestId: string
): string => {
  if (!/^[a-f0-9]{32}$/i.test(requestId)) {
    throw new Error('Invalid Windows PowerShell sidecar request identity.')
  }
  return `${promptMarkerPath}.${requestId.toLowerCase()}`
}

export const buildWindowsPowerShellInputRevisionPath = (
  promptMarkerPath: string
): string => `${promptMarkerPath}.input-revision`

export const serializeWindowsPowerShellInputRevision = (
  revision: number,
  minimumPromptSequence: number
): string => {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('Invalid PowerShell input revision.')
  }
  if (!Number.isSafeInteger(minimumPromptSequence) || minimumPromptSequence < 1) {
    throw new Error('Invalid PowerShell input prompt sequence.')
  }
  return `${revision}:${minimumPromptSequence}`
}

export const buildWindowsPowerShellDispatchInput = (
  _commandProtocolToken?: string
): string => `. $global:${WINDOWS_POWERSHELL_DISPATCH_VARIABLE}`

export const buildWindowsPowerShellDispatchRequest = (options: {
  requestId: string
  kind: WindowsPowerShellDispatchRequestKind
  command: string
}): string => {
  if (!/^[a-f0-9]{32}$/i.test(options.requestId)) {
    throw new Error('Invalid Windows PowerShell sidecar request identity.')
  }
  const kindCode = options.kind === 'probe' ? 'p' : 'c'
  return `${options.requestId.toLowerCase()}:${kindCode}:${Buffer.from(
    options.command,
    'utf8'
  ).toString('base64')}`
}

export const buildWindowsPowerShellBootstrapScript = (options: {
  readySequence: string
  readySequenceFromRuntimeVariable?: boolean
  commandTrackingMode: WindowsCommandTrackingMode
  promptMarkerPath?: string
  commandRequestPath?: string
  commandOutputPath?: string
  commandProtocolToken?: string
}): string => {
  const runtimeToken = /^[a-f0-9]{32}$/i.test(options.commandProtocolToken || '')
    ? options.commandProtocolToken!.toLowerCase()
    : undefined
  const commandProtocolNamespace = runtimeToken
    ? `gyshell_${runtimeToken}_`
    : 'gyshell_'
  const privateIdentifierPrefix = runtimeToken
    ? `__gyshell_${runtimeToken}`
    : '__gyshell'
  if (options.readySequenceFromRuntimeVariable && !runtimeToken) {
    throw new Error(
      'A runtime-scoped PowerShell ready variable requires a command protocol token.'
    )
  }
  // These values are interpolated into a script that is subsequently
  // namespaced by replacing private helper identifiers. Base64 keeps
  // arbitrary path text out of that replacement domain (a legitimate temp
  // path may itself contain the literal "__gyshell").
  const encodePath = (value: string | undefined): string =>
    Buffer.from(value || '', 'utf8').toString('base64')
  // The footer must execute in the same dynamic script block as the user's
  // final operation: Windows PowerShell 5.1 resets `$?` when a separate block
  // returns. Keep it to one helper call. ErrorRecord objects remain typed; the
  // shared formatting boundary below repairs only wrapper-attributed
  // InvocationInfo without discarding structured error details.
  const sidecarOutcomeFooter =
    `;& $global:${WINDOWS_POWERSHELL_OUTCOME_RECORDER_VARIABLE} ([bool]$?)`
  const sidecarValidUserBlockExecution =
    [
      `$__gyshell_outcome_footer='${escapePowerShellSingleQuotedString(sidecarOutcomeFooter)}'`,
      '$__gyshell_instrumented_cmd=$__gyshell_cmd',
      '$__gyshell_named_block=$null',
      "foreach($__gyshell_named_name in @('DynamicParamBlock','BeginBlock','ProcessBlock','EndBlock','CleanBlock')){$__gyshell_named_property=$__gyshell_user_ast.PSObject.Properties[$__gyshell_named_name];if($null -ne $__gyshell_named_property){$__gyshell_named_candidate=$__gyshell_named_property.Value;if($null -ne $__gyshell_named_candidate -and -not [bool]$__gyshell_named_candidate.Unnamed){$__gyshell_named_block=$__gyshell_named_candidate}}}",
      "if($null -ne $__gyshell_named_block){$__gyshell_insert_offset=[int]$__gyshell_named_block.Extent.EndOffset-1;if($__gyshell_insert_offset -lt 0 -or $__gyshell_cmd[$__gyshell_insert_offset] -ne '}'){throw 'GyShell could not safely instrument the parsed PowerShell named block.'};$__gyshell_instrumented_cmd=$__gyshell_cmd.Substring(0,$__gyshell_insert_offset)+[Environment]::NewLine+$__gyshell_outcome_footer+[Environment]::NewLine+$__gyshell_cmd.Substring($__gyshell_insert_offset)}else{$__gyshell_instrumented_cmd=$__gyshell_cmd+[Environment]::NewLine+$__gyshell_outcome_footer}",
      `$${WINDOWS_POWERSHELL_USER_BLOCK_VARIABLE}=[scriptblock]::Create($__gyshell_instrumented_cmd)`,
      'if($global:__gyshell_logical_user_native_exists){$global:LASTEXITCODE=$global:__gyshell_logical_user_native}else{Microsoft.PowerShell.Utility\\Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue}',
      "if($global:__gyshell_logical_user_ok){$null=$null}else{Microsoft.PowerShell.Utility\\Write-Error 'GyShell status restoration sentinel' -ErrorAction Ignore}",
      `. $${WINDOWS_POWERSHELL_USER_BLOCK_VARIABLE}`,
    ].join(';')
  const sidecarParseFailureExecution = [
    '$__gyshell_parse_exception=[Management.Automation.ParseException]::new([Management.Automation.Language.ParseError[]]$__gyshell_parse_errors)',
    '$__gyshell_parse_record=[Management.Automation.ErrorRecord]::new($__gyshell_parse_exception,[string]$__gyshell_parse_errors[0].ErrorId,[Management.Automation.ErrorCategory]::ParserError,$null)',
    '$null=$Error.Insert(0,$__gyshell_parse_record)',
    '$global:__gyshell_user_ok=$false',
    '$global:__gyshell_user_native=$LASTEXITCODE',
    '$global:__gyshell_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE)',
    '$global:__gyshell_user_error_count=@($Error).Count',
    '$global:__gyshell_user_error_ref=$Error[0]',
    '$global:__gyshell_user_exception=$__gyshell_parse_record',
    '$global:__gyshell_user_outcome_sampled=$true',
    '$global:__gyshell_user_outcome_set=$true',
    '$__gyshell_parse_record',
  ].join(';')
  const sidecarUserBlockExecution = [
    '$__gyshell_instrumented_cmd=$null',
    '$__gyshell_parse_tokens=$null',
    '$__gyshell_parse_errors=$null',
    '$__gyshell_user_ast=[Management.Automation.Language.Parser]::ParseInput($__gyshell_cmd,[ref]$__gyshell_parse_tokens,[ref]$__gyshell_parse_errors)',
    `if(@($__gyshell_parse_errors).Count -gt 0){${sidecarParseFailureExecution}}else{${sidecarValidUserBlockExecution}}`,
  ].join(';')
  // ErrorRecord.InvocationInfo is rewritten when an error crosses the dynamic
  // dot-source boundary, so it points at GyShell's private invocation/footer
  // instead of the user's source. Rebuild only the presentation record before
  // formatting: the exception, category, target, fully-qualified id, and
  // ErrorDetails remain structured while the false private call site is gone.
  const sidecarSafeOutputProjection =
    'Microsoft.PowerShell.Core\\ForEach-Object {' +
    'if($_ -is [Management.Automation.ErrorRecord]){' +
    '$__gyshell_error_definition=[string]$_.InvocationInfo.MyCommand.Definition;' +
    '$__gyshell_error_origin=$__gyshell_error_definition+[string]$_.InvocationInfo.MyCommand.Name+[string]$_.InvocationInfo.Line+[string]$_.InvocationInfo.PositionMessage;' +
    '$__gyshell_error_is_private=($null -ne $__gyshell_instrumented_cmd -and $__gyshell_error_definition -ceq [string]$__gyshell_instrumented_cmd)-or($__gyshell_error_origin -match \'(?i)__GyShell_Internal\');' +
    'if($__gyshell_error_is_private){' +
    '$__gyshell_safe_error=[Management.Automation.ErrorRecord]::new($_.Exception,[string]$_.FullyQualifiedErrorId,$_.CategoryInfo.Category,$_.TargetObject);' +
    'if($null -ne $_.ErrorDetails){$__gyshell_safe_error.ErrorDetails=$_.ErrorDetails};' +
    '$__gyshell_safe_error}else{$_}}else{$_}}'
  const sidecarCommandExecution =
    `if($__gyshell_has_request){$global:__gyshell_output_observed=[int64]0;$global:__gyshell_output_retained=[int64]0;$global:__gyshell_output_truncated=$false;$global:__gyshell_output_capture_failed=$false;$global:__gyshell_user_outcome_set=$false;$global:__gyshell_user_outcome_sampled=$false;$global:__gyshell_user_exception=$null;$global:__gyshell_output_stream=$null;try{$global:__gyshell_output_stream=[IO.File]::Open($global:__gyshell_output_path,[IO.FileMode]::Create,[IO.FileAccess]::Write,[IO.FileShare]::Read);$__gyshell_cmd=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__gyshell_request_payload));$__gyshell_host_width=[int]$Host.UI.RawUI.BufferSize.Width;$__gyshell_format_width=if($__gyshell_host_width -gt 0){[Math]::Max(${WINDOWS_POWERSHELL_FORMAT_WIDTH_MIN},[Math]::Min(${WINDOWS_POWERSHELL_FORMAT_WIDTH_MAX},$__gyshell_host_width))}else{${WINDOWS_POWERSHELL_FORMAT_WIDTH_FALLBACK}};$global:__gyshell_user_error_baseline_count=@($Error).Count;$global:__gyshell_user_error_baseline_ref=if($Error.Count -gt 0){$Error[0]}else{$null};. {try{${sidecarUserBlockExecution}}catch{$global:__gyshell_user_exception=$_;$global:__gyshell_user_ok=$false;$global:__gyshell_user_native=$LASTEXITCODE;$global:__gyshell_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE);$global:__gyshell_user_error_count=@($Error).Count;$global:__gyshell_user_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null};$global:__gyshell_user_outcome_sampled=$true;$global:__gyshell_user_outcome_set=$true;throw}finally{if(-not $global:__gyshell_user_outcome_set){$global:__gyshell_user_ok=$false;$global:__gyshell_user_native=$LASTEXITCODE;$global:__gyshell_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE);$global:__gyshell_user_error_count=@($Error).Count;$global:__gyshell_user_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null};$global:__gyshell_user_outcome_sampled=$false;$global:__gyshell_user_outcome_set=$true}}} *>&1 | ${sidecarSafeOutputProjection} | Microsoft.PowerShell.Utility\\Out-String -Stream -Width $__gyshell_format_width -ErrorAction Stop | Microsoft.PowerShell.Core\\ForEach-Object {__gyshell_capture_text (([string]$_)+[Environment]::NewLine)}}catch{if(-not $global:__gyshell_user_outcome_set){$global:__gyshell_user_ok=$false;$global:__gyshell_user_native=$LASTEXITCODE;$global:__gyshell_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE);$global:__gyshell_user_error_count=@($Error).Count;$global:__gyshell_user_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null};$global:__gyshell_user_outcome_sampled=$false;$global:__gyshell_user_outcome_set=$true};if($null -ne $global:__gyshell_user_exception){try{$global:__gyshell_user_exception | ${sidecarSafeOutputProjection} | Microsoft.PowerShell.Utility\\Out-String -Stream -Width $__gyshell_format_width -ErrorAction Stop | Microsoft.PowerShell.Core\\ForEach-Object {__gyshell_capture_text (([string]$_)+[Environment]::NewLine)}}catch{$global:__gyshell_output_capture_failed=$true}}else{$global:__gyshell_output_capture_failed=$true}}finally{if($null -ne $global:__gyshell_output_stream){try{$global:__gyshell_output_stream.Dispose()}catch{$global:__gyshell_output_capture_failed=$true};$global:__gyshell_output_stream=$null};$global:__gyshell_completed_request_id=$__gyshell_request_id;$global:__gyshell_completed_request_kind=$__gyshell_request_kind;$global:__gyshell_completion_pending=$true}}`
  // PowerShell's top-level break/continue can escape a dot-sourced user block.
  // Frame execution with finally so every non-process-terminating control-flow
  // path closes raw attribution before the next prompt is rendered.
  const sidecarFramedCommandExecution =
    `if($__gyshell_has_request){__gyshell_emit_raw_boundary 'preexec' $__gyshell_request_id;try{${sidecarCommandExecution}}finally{__gyshell_emit_raw_boundary 'preend' $__gyshell_request_id}}`
  const sidecarDispatchPreparation =
    'try{$__gyshell_dispatch_history=@(Microsoft.PowerShell.Core\\Get-History -ErrorAction SilentlyContinue|Microsoft.PowerShell.Core\\Where-Object {$_.CommandLine -ceq $global:__gyshell_dispatch_history_line});' +
    'if($__gyshell_dispatch_history.Count -gt 0){Microsoft.PowerShell.Core\\Clear-History -Id ([long[]]$__gyshell_dispatch_history.Id) -ErrorAction SilentlyContinue}}catch{};' +
    '[Console]::Clear()'
  const sidecarDispatchRequestBody =
    options.commandRequestPath && options.commandOutputPath
      ? [
        sidecarDispatchPreparation,
        '$__gyshell_request_raw=[IO.File]::ReadAllText($global:__gyshell_request_path,$__gyshell_utf8)',
        '$__gyshell_request_nonempty=-not [string]::IsNullOrEmpty($__gyshell_request_raw);$__gyshell_request_separator=if($__gyshell_request_nonempty){$__gyshell_request_raw.IndexOf(\':\')}else{-1};$__gyshell_request_id_valid=$__gyshell_request_separator -eq 32 -and $__gyshell_request_raw.Substring(0,32) -match \'^[a-fA-F0-9]{32}$\';$__gyshell_request_v2=$__gyshell_request_id_valid -and $__gyshell_request_raw.Length -ge 35 -and $__gyshell_request_raw[34] -eq \':\' -and $__gyshell_request_raw.Substring(33,1) -match \'^[pc]$\';$__gyshell_request_legacy=$__gyshell_request_id_valid -and -not $__gyshell_request_v2;$__gyshell_has_request=$__gyshell_request_v2 -or $__gyshell_request_legacy;$__gyshell_request_id=if($__gyshell_has_request){$__gyshell_request_raw.Substring(0,32).ToLowerInvariant()}else{\'\'};$__gyshell_request_kind=if($__gyshell_request_v2){$__gyshell_request_raw.Substring(33,1)}elseif($__gyshell_request_legacy){\'c\'}else{\'\'};$__gyshell_request_payload=if($__gyshell_request_v2){$__gyshell_request_raw.Substring(35)}elseif($__gyshell_request_legacy){$__gyshell_request_raw.Substring(33)}else{\'\'};if($__gyshell_request_nonempty){[IO.File]::WriteAllText($global:__gyshell_request_path,\'\',$__gyshell_utf8)}',
        sidecarFramedCommandExecution,
      ].join(';')
    : ''
  // A command can deliberately or accidentally dot-source the public stable
  // dispatcher while its own request is still running. Treat that as a no-op
  // before touching request-local variables. The outer try/finally also makes
  // top-level return/break/continue release the guard for the next request.
  const sidecarDispatchBody = sidecarDispatchRequestBody
    ? `if($NestedPromptLevel -eq 0 -and -not $global:__gyshell_completion_pending -and -not $global:__gyshell_dispatch_active){$global:__gyshell_dispatch_active=$true;try{${sidecarDispatchRequestBody}}finally{$global:__gyshell_dispatch_active=$false}}`
    : ''
  const readySequenceExpression = options.readySequenceFromRuntimeVariable
    ? `[string]$global:__gyshell_${WINDOWS_POWERSHELL_INITIALIZATION_READY_VARIABLE_SUFFIX}`
    : `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(options.readySequence, 'utf8').toString('base64')}'))`
  const readySequenceAssignment =
    `$__gyshell_ready_sequence=${readySequenceExpression}`
  const readyOutputStatement =
    `${readySequenceAssignment};` +
    '$__gyshell_ready_bytes=$__gyshell_utf8.GetBytes($__gyshell_ready_sequence);' +
    '$__gyshell_ready_stdout=[Console]::OpenStandardOutput();' +
    '$__gyshell_ready_stdout.Write($__gyshell_ready_bytes,0,$__gyshell_ready_bytes.Length);' +
    '$__gyshell_ready_stdout.Flush()'
  // -NoExit invokes prompt after the encoded bootstrap returns. Publishing
  // readiness inside that natural prompt makes one event prove both the
  // journal baseline and the visible prompt; an explicit prompt invocation
  // would create a stale extra sequence before the user can type.
  const sidecarReadySetup =
    `$global:__gyshell_pending_ready_sequence=${readySequenceExpression}`
  const sidecarReadyPromptStatement =
    'if($null -ne $global:__gyshell_pending_ready_sequence){' +
    '$__gyshell_ready_sequence=[string]$global:__gyshell_pending_ready_sequence;' +
    '$__gyshell_ready_bytes=[Text.Encoding]::UTF8.GetBytes($__gyshell_ready_sequence);' +
    '$__gyshell_ready_stdout=[Console]::OpenStandardOutput();' +
    '$__gyshell_ready_stdout.Write($__gyshell_ready_bytes,0,$__gyshell_ready_bytes.Length);' +
    '$__gyshell_ready_stdout.Flush();' +
    '$global:__gyshell_pending_ready_sequence=$null}'
  const sidecarPromptFrameStatement = runtimeToken
    ? '$__gyshell_prompt_frame=([string][char]27)+\']1337;' +
      commandProtocolNamespace +
      'precmd;seq=\'+$global:__gyshell_prompt_seq+\';ec=\'+$__ec+\';cwd_b64=\'+$__cwd_b64+\';home_b64=\'+$__home_b64+([string][char]7);' +
      '$__gyshell_prompt_stdout=[Console]::OpenStandardOutput();' +
      '$__gyshell_prompt_bytes=$__gyshell_utf8.GetBytes($__gyshell_prompt_frame);' +
      '$__gyshell_prompt_stdout.Write($__gyshell_prompt_bytes,0,$__gyshell_prompt_bytes.Length);' +
      '$__gyshell_prompt_stdout.Flush()'
    : ''
  // The client commits a monotonic input revision and its minimum prompt
  // sequence through the sidecar after writing the matching PTY bytes.
  // PowerShell.OnIdle does not consume the revision until both that prompt
  // floor and an empty PSReadLine buffer are observed. This is required
  // because PTY and SFTP are independent SSH channels: the sidecar write may
  // become visible while PowerShell is still sitting at the older prompt.
  // Multiline input and foreground stdin naturally defer the acknowledgement
  // until their one final top-level prompt without replacing any key binding.
  const sidecarInputIdleTrackingSetup = runtimeToken
    ? 'Get-PSReadLineOption -ErrorAction Stop|Out-Null;' +
      '$global:__gyshell_last_input_idle_revision=0;' +
      '$global:__gyshell_input_idle_subscription=Register-EngineEvent -SourceIdentifier PowerShell.OnIdle -SupportEvent -ErrorAction Stop -Action {' +
      'try{' +
      'if($NestedPromptLevel -eq 0){' +
      '$__gyshell_input_revision_text=[IO.File]::ReadAllText($global:__gyshell_input_revision_path,$global:__gyshell_utf8).Trim();' +
      '$__gyshell_input_revision_parts=$__gyshell_input_revision_text.Split(\':\');' +
      'if($__gyshell_input_revision_parts.Length -eq 2 -and $__gyshell_input_revision_parts[0] -match \'^[1-9][0-9]{0,15}$\' -and $__gyshell_input_revision_parts[1] -match \'^[1-9][0-9]{0,9}$\'){' +
      '$__gyshell_input_revision=[int64]$__gyshell_input_revision_parts[0];' +
      '$__gyshell_input_minimum_prompt_seq=[int]$__gyshell_input_revision_parts[1];' +
      'if($__gyshell_input_revision -gt [int64]$global:__gyshell_last_input_idle_revision -and [int]$global:__gyshell_prompt_seq -ge $__gyshell_input_minimum_prompt_seq){' +
      '$__gyshell_input_line=$null;$__gyshell_input_cursor=0;' +
      '[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$__gyshell_input_line,[ref]$__gyshell_input_cursor);' +
      'if([string]::IsNullOrEmpty([string]$__gyshell_input_line) -and $__gyshell_input_cursor -eq 0){' +
      '$__gyshell_input_idle_seq=[int]$global:__gyshell_prompt_seq;' +
      '$__gyshell_input_idle_frame=([string][char]27)+\']1337;' +
      commandProtocolNamespace +
      'inputidle;seq=\'+$__gyshell_input_idle_seq+\';rev=\'+$__gyshell_input_revision+\';nonce=manual_input_drained\'+([string][char]7);' +
      '$__gyshell_input_idle_stdout=[Console]::OpenStandardOutput();' +
      '$__gyshell_input_idle_bytes=$global:__gyshell_utf8.GetBytes($__gyshell_input_idle_frame);' +
      '$__gyshell_input_idle_stdout.Write($__gyshell_input_idle_bytes,0,$__gyshell_input_idle_bytes.Length);' +
      '$__gyshell_input_idle_stdout.Flush();' +
      '$global:__gyshell_last_input_idle_revision=$__gyshell_input_revision}' +
      '}' +
      '}' +
      '}' +
      '}catch{}' +
      '}'
    : ''
  const sidecarHistoryFilteringSetup = runtimeToken
    ? '$global:__gyshell_dispatch_history_line=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(\'' +
      Buffer.from(buildWindowsPowerShellDispatchInput(), 'utf8').toString('base64') +
      '\'));' +
      'if(-not (Test-Path Variable:Global:__gyshell_original_history_handler)){' +
      '$global:__gyshell_original_history_handler=(Get-PSReadLineOption -ErrorAction Stop).AddToHistoryHandler};' +
      'Set-PSReadLineOption -AddToHistoryHandler {' +
      'param([string]$line);' +
      'if($line -ceq $global:__gyshell_dispatch_history_line){return $false};' +
      'if($null -ne $global:__gyshell_original_history_handler){return $global:__gyshell_original_history_handler.Invoke($line)};' +
      '$true' +
      '} -ErrorAction Stop'
    : ''
  const sidecarPromptBody = [
    '$__gyshell_prompt_ok=$?;$__gyshell_prompt_native=$LASTEXITCODE;$__gyshell_prompt_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE);$__gyshell_prompt_error_count=@($Error).Count;$__gyshell_prompt_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null}',
    '$__gyshell_has_request=$global:__gyshell_completion_pending -and $global:__gyshell_completed_request_id -match \'^[a-fA-F0-9]{32}$\' -and $global:__gyshell_completed_request_kind -match \'^[pc]$\';$__gyshell_request_id=if($__gyshell_has_request){$global:__gyshell_completed_request_id}else{\'\'};$__gyshell_request_kind=if($__gyshell_has_request){$global:__gyshell_completed_request_kind}else{\'\'}',
    '$__ok=if($__gyshell_has_request){$global:__gyshell_user_ok}else{$__gyshell_prompt_ok};$__native=if($__gyshell_has_request){$global:__gyshell_user_native}else{$__gyshell_prompt_native};$__native_exists=if($__gyshell_has_request){$global:__gyshell_user_native_exists}else{$__gyshell_prompt_native_exists};$__error_count=if($__gyshell_has_request){$global:__gyshell_user_error_count}else{$__gyshell_prompt_error_count};$__error_ref=if($__gyshell_has_request){$global:__gyshell_user_error_ref}else{$__gyshell_prompt_error_ref};$__error_baseline_count=if($__gyshell_has_request){$global:__gyshell_user_error_baseline_count}else{$global:__gyshell_last_error_count};$__error_baseline_ref=if($__gyshell_has_request){$global:__gyshell_user_error_baseline_ref}else{$global:__gyshell_last_error_ref}',
    '$__has_new_error=($__error_count -gt 0) -and (($__error_count -ne [int]$__error_baseline_count) -or ($__error_ref -ne $__error_baseline_ref));$__has_native_error=$__has_new_error -and (([string]$__error_ref.FullyQualifiedErrorId) -like \'NativeCommandError*\');$__user_threw=$__gyshell_has_request -and $null -ne $global:__gyshell_user_exception;$__returned_without_sample=$__gyshell_has_request -and -not $global:__gyshell_user_outcome_sampled -and -not $__user_threw',
    '$__outcome_known=$true;$__ec=if($__returned_without_sample){$__outcome_known=$false;1}elseif($__ok){0}elseif($__user_threw){1}elseif($__has_native_error){$__outcome_known=$false;if($__native -is [int]){$__native}else{1}}elseif($__native -is [int] -and $__native -ne 0){$__outcome_known=$false;$__native}else{1}',
    'if(-not $__gyshell_has_request -or $__gyshell_request_kind -eq \'c\'){$global:__gyshell_logical_user_ok=[bool]$__ok;$global:__gyshell_logical_user_native=$__native;$global:__gyshell_logical_user_native_exists=[bool]$__native_exists};$global:__gyshell_last_error_count=$__error_count;$global:__gyshell_last_error_ref=$__error_ref;$__output_observed=if($__gyshell_has_request){[int64]$global:__gyshell_output_observed}else{[int64]0};$__output_retained=if($__gyshell_has_request){[int64]$global:__gyshell_output_retained}else{[int64]0};$__output_truncated=if($__gyshell_has_request -and $global:__gyshell_output_truncated){1}else{0};$__output_capture_failed=if($__gyshell_has_request -and $global:__gyshell_output_capture_failed){1}else{0};$__outcome_known_int=if($__outcome_known){1}else{0};$global:__gyshell_prompt_seq=[int]$global:__gyshell_prompt_seq+1;$__cwd_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path));$__home_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME));$__line=\'__GYSHELL_PROMPT__::seq=\'+$global:__gyshell_prompt_seq+\';ec=\'+$__ec+\';outcome_known=\'+$__outcome_known_int+\';request_id=\'+$__gyshell_request_id+\';output_bytes=\'+$__output_observed+\';retained_bytes=\'+$__output_retained+\';output_truncated=\'+$__output_truncated+\';output_capture_failed=\'+$__output_capture_failed+\';cwd_b64=\'+$__cwd_b64+\';home_b64=\'+$__home_b64',
    '[IO.File]::AppendAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8);if($__gyshell_has_request){$__gyshell_request_marker=$global:__gyshell_marker_path+\'.\'+$__gyshell_request_id;$__gyshell_request_marker_tmp=$__gyshell_request_marker+\'.tmp\';if(Test-Path -LiteralPath $__gyshell_request_marker_tmp){Remove-Item -LiteralPath $__gyshell_request_marker_tmp -Force -ErrorAction SilentlyContinue};[IO.File]::WriteAllText($__gyshell_request_marker_tmp,$__line+[Environment]::NewLine,$__gyshell_utf8);if(Test-Path -LiteralPath $__gyshell_request_marker){Remove-Item -LiteralPath $__gyshell_request_marker -Force};[IO.File]::Move($__gyshell_request_marker_tmp,$__gyshell_request_marker);$global:__gyshell_completion_pending=$false;$global:__gyshell_completed_request_id=\'\';$global:__gyshell_completed_request_kind=\'\'}',
    sidecarPromptFrameStatement,
    sidecarReadyPromptStatement,
    '\'PS \'+$PWD.Path+\'> \'',
  ]
    .filter(Boolean)
    .join(';')
  // Windows PowerShell 5.1 inherits a legacy console code page even when the
  // SSH transport itself is UTF-8. Set every interactive byte boundary once
  // during bootstrap so both shell input and streamed/native output preserve
  // Unicode before the transcript or sidecar capture layer observes it.
  const utf8ConsoleInit =
    '$__gyshell_utf8=[Text.UTF8Encoding]::new($false);[Console]::InputEncoding=$__gyshell_utf8;[Console]::OutputEncoding=$__gyshell_utf8;$OutputEncoding=$__gyshell_utf8'
  const inBandPromptBody = [
    '$__gyshell_ok=$?;$__gyshell_native=$LASTEXITCODE;$__gyshell_error_count=@($Error).Count;$__gyshell_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null}',
    '$__gyshell_has_new_error=($__gyshell_error_count -gt 0) -and (($__gyshell_error_count -ne [int]$global:__gyshell_last_error_count) -or ($__gyshell_error_ref -ne $global:__gyshell_last_error_ref));$__gyshell_has_native_error=$__gyshell_has_new_error -and (([string]$__gyshell_error_ref.FullyQualifiedErrorId) -like \'NativeCommandError*\');$__gyshell_outcome_known=$true;$__gyshell_ec=if($__gyshell_ok){0}elseif($__gyshell_has_native_error){$__gyshell_outcome_known=$false;if($__gyshell_native -is [int]){$__gyshell_native}else{1}}elseif($__gyshell_native -is [int] -and $__gyshell_native -ne 0){$__gyshell_outcome_known=$false;$__gyshell_native}else{1}',
    '$global:__gyshell_last_error_count=$__gyshell_error_count;$global:__gyshell_last_error_ref=$__gyshell_error_ref;$global:__gyshell_prompt_seq=[int]$global:__gyshell_prompt_seq+1;$__gyshell_cwd_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($PWD.Path));$__gyshell_home_b64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($HOME));$__gyshell_ec_field=if($__gyshell_outcome_known){\';ec=\'+$__gyshell_ec}else{\'\'}',
    `Write-Host -NoNewline "$([char]27)]1337;${commandProtocolNamespace}precmd;seq=$($global:__gyshell_prompt_seq)$__gyshell_ec_field;cwd_b64=$__gyshell_cwd_b64;home_b64=$__gyshell_home_b64$([char]7)";"PS $($PWD.Path)> "`,
  ].join(';')
  const psInit =
    options.commandTrackingMode === 'windows-powershell-sidecar' && options.promptMarkerPath
      ? [
          '$global:__gyshell_logical_user_ok=[bool]$?;$global:__gyshell_logical_user_native=$LASTEXITCODE;$global:__gyshell_logical_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE)',
          utf8ConsoleInit,
          `$global:__gyshell_marker_path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(options.promptMarkerPath)}'))`,
          `$global:__gyshell_input_revision_path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(buildWindowsPowerShellInputRevisionPath(options.promptMarkerPath))}'))`,
          `$global:__gyshell_request_path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(options.commandRequestPath)}'))`,
          `$global:__gyshell_output_path=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(options.commandOutputPath)}'))`,
          `$global:__gyshell_output_max_bytes=[int64]${COMMAND_CAPTURE_MAX_UTF8_BYTES}`,
          '$global:__gyshell_output_observed=[int64]0',
          '$global:__gyshell_output_retained=[int64]0',
          '$global:__gyshell_output_truncated=$false',
          '$global:__gyshell_output_capture_failed=$false',
          '$global:__gyshell_output_stream=$null',
          '$global:__gyshell_completed_request_id=\'\'',
          '$global:__gyshell_completed_request_kind=\'\'',
          '$global:__gyshell_completion_pending=$false',
          '$global:__gyshell_dispatch_active=$false',
          `$global:__gyshell_prompt_seq=${WINDOWS_POWERSHELL_INITIAL_PROMPT_SEQUENCE - 1}`,
          '$global:__gyshell_last_error_count=@($Error).Count',
          '$global:__gyshell_last_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null}',
          '[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($global:__gyshell_marker_path))|Out-Null',
          "[IO.File]::WriteAllText($global:__gyshell_marker_path,'',$__gyshell_utf8)",
          "[IO.File]::WriteAllText($global:__gyshell_input_revision_path,'0:0',$__gyshell_utf8)",
          options.commandRequestPath
            ? "[IO.File]::WriteAllText($global:__gyshell_request_path,'',$__gyshell_utf8)"
            : '',
          options.commandOutputPath
            ? "[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)"
            : '',
          sidecarInputIdleTrackingSetup,
          sidecarHistoryFilteringSetup,
          'function Global:__gyshell_capture_text{param([AllowNull()][object]$value);try{$__gyshell_text=[string]$value;$__gyshell_bytes=$global:__gyshell_utf8.GetBytes($__gyshell_text);$global:__gyshell_output_observed=[int64]$global:__gyshell_output_observed+[int64]$__gyshell_bytes.Length;if($global:__gyshell_output_truncated){return};$__gyshell_remaining=[int64]$global:__gyshell_output_max_bytes-[int64]$global:__gyshell_output_retained;if($__gyshell_remaining -le 0){if($__gyshell_bytes.Length -gt 0){$global:__gyshell_output_truncated=$true};return};$__gyshell_take=[int][Math]::Min([int64]$__gyshell_bytes.Length,$__gyshell_remaining);if($__gyshell_take -lt $__gyshell_bytes.Length){while($__gyshell_take -gt 0 -and (($__gyshell_bytes[$__gyshell_take] -band 0xC0) -eq 0x80)){$__gyshell_take--};$global:__gyshell_output_truncated=$true};if($__gyshell_take -gt 0){$global:__gyshell_output_stream.Write($__gyshell_bytes,0,$__gyshell_take);$global:__gyshell_output_retained=[int64]$global:__gyshell_output_retained+[int64]$__gyshell_take};if($__gyshell_take -lt $__gyshell_bytes.Length){$global:__gyshell_output_truncated=$true}}catch{$global:__gyshell_output_capture_failed=$true}}',
          `Set-Variable -Scope Global -Name '${WINDOWS_POWERSHELL_OUTCOME_RECORDER_VARIABLE}' -Value {param([bool]$ok);$global:__gyshell_user_ok=$ok;$global:__gyshell_user_native=$LASTEXITCODE;$global:__gyshell_user_native_exists=[bool](Test-Path Variable:Global:LASTEXITCODE);$global:__gyshell_user_error_count=@($Error).Count;$global:__gyshell_user_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null};$global:__gyshell_user_outcome_sampled=$true;$global:__gyshell_user_outcome_set=$true} -Option ReadOnly -Force`,
          `function Global:__gyshell_emit_raw_boundary{param([string]$kind,[string]$nonce);try{$__gyshell_seq=[int]$global:__gyshell_prompt_seq+1;$__gyshell_stdout=[Console]::OpenStandardOutput();if($kind -eq 'preexec'){$__gyshell_sync=([string][char]27)+']1337;${commandProtocolNamespace}preexec;seq='+$__gyshell_seq+';nonce=00000000000000000000000000000000'+([string][char]7)+([string][char]27)+'[m';$__gyshell_sync_bytes=$global:__gyshell_utf8.GetBytes($__gyshell_sync);$__gyshell_stdout.Write($__gyshell_sync_bytes,0,$__gyshell_sync_bytes.Length);$__gyshell_stdout.Flush()};$__gyshell_frame=([string][char]27)+']1337;${commandProtocolNamespace}'+$kind+';seq='+$__gyshell_seq+';nonce='+$nonce+([string][char]7);$__gyshell_frame_bytes=$global:__gyshell_utf8.GetBytes($__gyshell_frame);$__gyshell_stdout.Write($__gyshell_frame_bytes,0,$__gyshell_frame_bytes.Length);$__gyshell_stdout.Flush()}catch{}}`,
          `Set-Variable -Scope Global -Name '${WINDOWS_POWERSHELL_DISPATCH_VARIABLE}' -Value ([scriptblock]::Create(@'\n${sidecarDispatchBody}\n'@\n)) -Option ReadOnly -Force`,
          sidecarReadySetup,
          `Set-Item -Path Function:\\Global:prompt -Value {${sidecarPromptBody}} -Force -Options 'AllScope,ReadOnly'`,
          '$global:__gyshell_bootstrap_installed=$true',
          'Clear-Host',
        ]
          .filter(Boolean)
          .join(';')
      : `${utf8ConsoleInit};$global:__gyshell_prompt_seq=0;$global:__gyshell_last_error_count=@($Error).Count;$global:__gyshell_last_error_ref=if($Error.Count -gt 0){$Error[0]}else{$null};Set-Item -Path Function:\\Global:prompt -Value {${inBandPromptBody}} -Force -Options 'AllScope,ReadOnly';Clear-Host;${readyOutputStatement}`

  // The user command is dot-sourced into this runspace, so fixed state names
  // are collision-prone even when the OSC frame itself is namespaced. Apply a
  // runtime-private namespace to all lowercase __gyshell state and helpers.
  // The three explicitly named __GyShell_Internal* scriptblock entry points
  // stay stable so PowerShell diagnostics never disclose the runtime token.
  // This prevents accidental collisions and disclosure; the shared runspace
  // is intentionally not a security boundary against deliberate introspection.
  const runtimePrivatePsInit =
    privateIdentifierPrefix === '__gyshell'
      ? psInit
      : psInit.split('__gyshell').join(privateIdentifierPrefix)
  return runtimePrivatePsInit
}

export const buildWindowsPowerShellEncodedCommand = (
  options: Parameters<typeof buildWindowsPowerShellBootstrapScript>[0]
): string =>
  Buffer.from(buildWindowsPowerShellBootstrapScript(options), 'utf16le').toString(
    'base64'
  )

export const buildWindowsPowerShellBootstrapLoaderEncodedCommand = (
  bootstrapPath: string,
  options?: {
    readySequence: string
    readyMarkerVariableName: string
  }
): string => {
  if (
    options &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.readyMarkerVariableName)
  ) {
    throw new Error('Invalid Windows PowerShell initialization variable name.')
  }
  const encodedPath = Buffer.from(bootstrapPath, 'utf8').toString('base64')
  const encodedReadySequence = options
    ? Buffer.from(options.readySequence, 'utf8').toString('base64')
    : ''
  const loader =
    (options
      ? `$global:${options.readyMarkerVariableName}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedReadySequence}'));`
      : '') +
    `$__gyshell_bootstrap_path=[Text.Encoding]::UTF8.GetString(` +
    `[Convert]::FromBase64String('${encodedPath}'));. $__gyshell_bootstrap_path`
  return Buffer.from(loader, 'utf16le').toString('base64')
}

export const parseWindowsPromptMarkerLine = (
  line: string
): WindowsPromptMarkerState | null => {
  const normalized = String(line || '').replace(/^\ufeff/, '').trim()
  if (!normalized.startsWith(WINDOWS_PROMPT_MARKER_PREFIX)) {
    return null
  }
  const encodedFields = normalized.slice(WINDOWS_PROMPT_MARKER_PREFIX.length).split(';')
  const fields = new Map<string, string>()
  for (const encodedField of encodedFields) {
    const separator = encodedField.indexOf('=')
    if (separator <= 0) {
      return null
    }
    const key = encodedField.slice(0, separator)
    if (fields.has(key)) {
      return null
    }
    fields.set(key, encodedField.slice(separator + 1))
  }

  const sequenceRaw = fields.get('seq')
  const exitCodeRaw = fields.get('ec')
  const outcomeKnownRaw = fields.get('outcome_known')
  const cwdRaw = fields.get('cwd_b64')
  const homeRaw = fields.get('home_b64')
  if (
    !sequenceRaw ||
    !/^\d+$/.test(sequenceRaw) ||
    !exitCodeRaw ||
    !/^-?\d+$/.test(exitCodeRaw) ||
    cwdRaw === undefined ||
    homeRaw === undefined
  ) {
    return null
  }

  const sequence = Number.parseInt(sequenceRaw, 10)
  const exitCode = Number.parseInt(exitCodeRaw, 10)
  if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(exitCode)) {
    return null
  }
  if (outcomeKnownRaw !== undefined && !/^[01]$/.test(outcomeKnownRaw)) {
    return null
  }
  const outcomeKnown = outcomeKnownRaw !== '0'

  const requestIdRaw = fields.get('request_id')
  if (
    requestIdRaw !== undefined &&
    requestIdRaw !== '' &&
    !/^[a-f0-9]{32}$/i.test(requestIdRaw)
  ) {
    return null
  }
  const outputBytesRaw = fields.get('output_bytes')
  const outputRetainedRaw = fields.get('retained_bytes')
  const outputTruncatedRaw = fields.get('output_truncated')
  const outputCaptureFailedRaw = fields.get('output_capture_failed')
  if (
    (outputBytesRaw === undefined) !== (outputTruncatedRaw === undefined) ||
    (outputRetainedRaw !== undefined && outputBytesRaw === undefined) ||
    (outputCaptureFailedRaw !== undefined && outputBytesRaw === undefined)
  ) {
    return null
  }
  let outputObservedUtf8Bytes: number | undefined
  let outputRetainedUtf8Bytes: number | undefined
  let outputTruncated: boolean | undefined
  let outputCaptureFailed: boolean | undefined
  if (outputBytesRaw !== undefined && outputTruncatedRaw !== undefined) {
    if (!/^\d+$/.test(outputBytesRaw) || !/^[01]$/.test(outputTruncatedRaw)) {
      return null
    }
    outputObservedUtf8Bytes = Number.parseInt(outputBytesRaw, 10)
    if (!Number.isSafeInteger(outputObservedUtf8Bytes)) {
      return null
    }
    outputTruncated = outputTruncatedRaw === '1'
  }
  if (outputCaptureFailedRaw !== undefined) {
    if (!/^[01]$/.test(outputCaptureFailedRaw)) {
      return null
    }
    outputCaptureFailed = outputCaptureFailedRaw === '1'
  }
  if (outputRetainedRaw !== undefined) {
    if (!/^\d+$/.test(outputRetainedRaw)) {
      return null
    }
    outputRetainedUtf8Bytes = Number.parseInt(outputRetainedRaw, 10)
    if (
      !Number.isSafeInteger(outputRetainedUtf8Bytes) ||
      (outputObservedUtf8Bytes !== undefined &&
        outputRetainedUtf8Bytes > outputObservedUtf8Bytes)
    ) {
      return null
    }
  }
  if (
    outputTruncated === false &&
    outputCaptureFailed !== true &&
    outputObservedUtf8Bytes !== undefined &&
    outputRetainedUtf8Bytes !== undefined &&
    outputRetainedUtf8Bytes !== outputObservedUtf8Bytes
  ) {
    return null
  }

  const decode = (value: string): string | undefined => {
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8')
      const sanitized = decoded.replace(/[\u0000-\u001f\u007f]/g, '')
      return sanitized.length > 0 ? sanitized : undefined
    } catch {
      return undefined
    }
  }

  return {
    sequence,
    ...(outcomeKnown ? { exitCode } : {}),
    ...(outcomeKnownRaw !== undefined ? { outcomeKnown } : {}),
    ...(requestIdRaw ? { requestId: requestIdRaw.toLowerCase() } : {}),
    ...(outputObservedUtf8Bytes !== undefined
      ? {
          outputObservedUtf8Bytes,
          outputRetainedUtf8Bytes,
          outputTruncated,
          ...(outputCaptureFailed !== undefined
            ? { outputCaptureFailed }
            : {}),
        }
      : {}),
    cwd: decode(cwdRaw),
    homeDir: decode(homeRaw)
  }
}

export const parseWindowsPowerShellRequestMarkerFile = (
  contents: string,
  expectedRequestId: string
): WindowsPromptMarkerState | null => {
  const normalizedRequestId = expectedRequestId.toLowerCase()
  if (!/^[a-f0-9]{32}$/.test(normalizedRequestId)) {
    return null
  }
  const nonEmptyLines = String(contents || '')
    .replace(/^\ufeff/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
  if (nonEmptyLines.length !== 1) {
    return null
  }
  const parsed = parseWindowsPromptMarkerLine(nonEmptyLines[0] || '')
  return parsed?.requestId === normalizedRequestId ? parsed : null
}
