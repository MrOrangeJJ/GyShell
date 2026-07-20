import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { COMMAND_CAPTURE_MAX_UTF8_BYTES } from '@gyshell/shared'
import { NodePtyBackend } from './NodePtyBackend'
import {
  buildInitializationReadyMarker,
  consumeInitializationReadyMarker,
} from './terminal/CommandStreamProtocol'
import {
  buildWindowsPowerShellDispatchRequest,
  buildWindowsPowerShellDispatchInput,
  parseWindowsPromptMarkerLine,
  parseWindowsPowerShellRequestMarkerFile,
  WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES,
} from './windowsPowerShellTracking'

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(`${message}. expected=${String(expected)} actual=${String(actual)}`)
  }
}

const assertCondition = (condition: unknown, message: string): void => {
  if (!condition) {
    throw new Error(message)
  }
}

const runCase = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  console.log(`PASS ${name}`)
}

const run = async (): Promise<void> => {
  await runCase('Windows prompt-file requests carry an explicit execution role', () => {
    const requestId = 'ABCDEF0123456789ABCDEF0123456789'
    const probe = buildWindowsPowerShellDispatchRequest({
      requestId,
      kind: 'probe',
      command: `'probe'`,
    })
    const command = buildWindowsPowerShellDispatchRequest({
      requestId,
      kind: 'command',
      command: 'Write-Output 汉字',
    })

    assertCondition(
      probe.startsWith(`${requestId.toLowerCase()}:p:`) &&
        Buffer.from(probe.slice(35), 'base64').toString('utf8') === `'probe'`,
      'probe requests should be typed without changing their source bytes'
    )
    assertCondition(
      command.startsWith(`${requestId.toLowerCase()}:c:`) &&
        Buffer.from(command.slice(35), 'base64').toString('utf8') ===
          'Write-Output 汉字',
      'user requests should be typed without changing their Unicode source'
    )
  })

  await runCase('initialization consumes only its runtime-scoped ready marker', () => {
    const runtimeToken = '0123456789abcdef0123456789abcdef'
    const marker = buildInitializationReadyMarker(runtimeToken)
    const remainder = consumeInitializationReadyMarker(
      `discarded bootstrap output\r\n+ echo ${marker}\r\n${marker}\r\nPS> before${marker}after`,
      marker
    )

    assertEqual(
      remainder,
      `\r\nPS> before${marker}after`,
      'only the first expected initialization marker may be consumed'
    )
    assertEqual(
      consumeInitializationReadyMarker(`\r\n${marker}`, marker),
      undefined,
      'a marker without its trailing line boundary must stay buffered'
    )
  })

  await runCase('Windows prompt markers parse bounded-output metadata without breaking legacy markers', () => {
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Admin', 'utf8').toString('base64')
    const legacy = parseWindowsPromptMarkerLine(
      `__GYSHELL_PROMPT__::seq=7;ec=0;cwd_b64=${cwdB64};home_b64=${homeB64}`
    )
    const bounded = parseWindowsPromptMarkerLine(
      `__GYSHELL_PROMPT__::seq=8;ec=1;request_id=0123456789abcdef0123456789abcdef;output_bytes=20000000;retained_bytes=16777216;output_truncated=1;cwd_b64=${cwdB64};home_b64=${homeB64}`
    )

    assertEqual(legacy?.sequence, 7, 'legacy sidecar markers should remain readable')
    assertEqual(
      legacy?.outputObservedUtf8Bytes,
      undefined,
      'legacy markers should not invent output-retention metadata'
    )
    assertEqual(
      bounded?.outputObservedUtf8Bytes,
      20000000,
      'new markers should carry the full generator-observed byte count'
    )
    assertEqual(bounded?.outputTruncated, true, 'new markers should carry truncation state')
    assertEqual(
      bounded?.requestId,
      '0123456789abcdef0123456789abcdef',
      'new markers should bind completion to one hidden request'
    )
    assertEqual(
      bounded?.outputRetainedUtf8Bytes,
      16777216,
      'new markers should carry the exact retained file length'
    )
    const unknownOutcome = parseWindowsPromptMarkerLine(
      `__GYSHELL_PROMPT__::seq=9;ec=1;outcome_known=0;request_id=1123456789abcdef0123456789abcdef;output_bytes=4;retained_bytes=4;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`
    )
    assertEqual(
      unknownOutcome?.outcomeKnown,
      false,
      'a sidecar marker should explicitly preserve an indeterminate shell outcome'
    )
    assertEqual(
      unknownOutcome?.exitCode,
      undefined,
      'an untrustworthy diagnostic exit code must not escape as an authoritative result'
    )
    assertEqual(
      parseWindowsPromptMarkerLine(
        `__GYSHELL_PROMPT__::seq=10;ec=0;output_bytes=12;cwd_b64=${cwdB64};home_b64=${homeB64}`
      ),
      null,
      'half-present bounded-output metadata must fail closed'
    )
    assertEqual(
      parseWindowsPromptMarkerLine(
        `__GYSHELL_PROMPT__::seq=11;ec=0;output_bytes=100;retained_bytes=5;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`
      ),
      null,
      'a marker cannot deny truncation when observed output exceeds retained output'
    )
    assertEqual(
      parseWindowsPromptMarkerLine(
        `__GYSHELL_PROMPT__::seq=12;ec=1;outcome_known=2;cwd_b64=${cwdB64};home_b64=${homeB64}`
      ),
      null,
      'unknown-outcome metadata must use the exact boolean wire representation'
    )
    const exactLine = `__GYSHELL_PROMPT__::seq=13;ec=0;request_id=0123456789abcdef0123456789abcdef;output_bytes=0;retained_bytes=0;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`
    assertEqual(
      parseWindowsPowerShellRequestMarkerFile(
        `${exactLine}\n`,
        '0123456789abcdef0123456789abcdef'
      )?.sequence,
      13,
      'a request commit should contain exactly one matching marker'
    )
    assertEqual(
      parseWindowsPowerShellRequestMarkerFile(
        `${exactLine}\n${exactLine}\n`,
        '0123456789abcdef0123456789abcdef'
      ),
      null,
      'multiple non-empty lines must invalidate an immutable request commit'
    )
  })

  await runCase('local immutable request markers are bounded and never replaced by journal cache', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-exact-marker-'))
    const markerPath = path.join(tempDir, 'prompt.log')
    const requestId = '2123456789abcdef2123456789abcdef'
    const exactPath = `${markerPath}.${requestId}`
    backend.promptMarkerPathByPtyId.set('pty-exact-marker', markerPath)
    backend.promptMarkerStateByPtyId.set('pty-exact-marker', {
      sequence: 99,
      requestId,
    })

    try {
      const missing = await backend.refreshPromptMarkerState('pty-exact-marker', {
        expectedRequestId: requestId,
      })
      assertEqual(
        missing,
        null,
        'a matching mutable journal cache must not impersonate an absent commit file'
      )

      fs.writeFileSync(
        exactPath,
        'x'.repeat(WINDOWS_POWERSHELL_REQUEST_MARKER_MAX_UTF8_BYTES + 1),
        'utf8'
      )
      const oversized = await Promise.allSettled([
        backend.refreshPromptMarkerState('pty-exact-marker', {
          expectedRequestId: requestId,
        }),
      ])
      assertEqual(
        oversized[0]?.status,
        'rejected',
        'an oversized immutable marker must be a protocol error, not pending completion'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('downlevel local windows powershell sessions switch to hidden sidecar tracking', async () => {
    const backend = new NodePtyBackend()
    const tracking = (backend as any).resolveWindowsShellTracking('powershell.exe', '10.0.14393')
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand(
      tracking.commandTrackingMode,
      tracking.promptMarkerPath,
      tracking.commandRequestPath,
      tracking.commandOutputPath
    ) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertEqual(
      tracking.commandTrackingMode,
      'windows-powershell-sidecar',
      'downlevel local windows powershell should use the sidecar route'
    )
    assertCondition(
      typeof tracking.tmpPath === 'string' && tracking.tmpPath.length > 0,
      'downlevel sidecar mode should allocate a temp directory for marker storage'
    )
    assertCondition(
      typeof tracking.promptMarkerPath === 'string' && tracking.promptMarkerPath.startsWith(tracking.tmpPath),
      'prompt marker file should live inside the temp directory'
    )
    assertCondition(
      typeof tracking.commandRequestPath === 'string' && tracking.commandRequestPath.startsWith(tracking.tmpPath),
      'prompt-file dispatch should store its hidden command request file inside the same temp directory'
    )
    assertCondition(
      typeof tracking.commandOutputPath === 'string' && tracking.commandOutputPath.startsWith(tracking.tmpPath),
      'prompt-file dispatch should store its hidden command output file inside the same temp directory'
    )
    assertCondition(
      decoded.includes('[Console]::InputEncoding=$__gyshell_utf8;[Console]::OutputEncoding=$__gyshell_utf8;$OutputEncoding=$__gyshell_utf8'),
      'downlevel local PowerShell sidecars must use UTF-8 for console and native-pipeline bytes'
    )
    assertCondition(
      decoded.includes("[IO.File]::AppendAllText($global:__gyshell_marker_path,$__line+[Environment]::NewLine,$__gyshell_utf8)"),
      'local sidecar prompt should journal markers so a later unrelated prompt cannot erase a matching completion'
    )
    assertCondition(
      decoded.includes("[IO.File]::WriteAllText($global:__gyshell_output_path,'',$__gyshell_utf8)"),
      'local sidecar prompt should initialize the hidden output file inside the temp directory'
    )
    assertCondition(
      (decoded.match(/\[scriptblock\]::Create\(\$__gyshell_instrumented_cmd\)/g) || []).length === 1,
      'local sidecar prompt must contain exactly one user-command invocation'
    )
    assertCondition(
      decoded.includes('Out-String -Stream -Width 2147483647') &&
        decoded.includes(`$global:__gyshell_output_max_bytes=[int64]${COMMAND_CAPTURE_MAX_UTF8_BYTES}`) &&
        decoded.includes('$global:__gyshell_output_observed=[int64]$global:__gyshell_output_observed+[int64]$__gyshell_bytes.Length;if($global:__gyshell_output_truncated){return}'),
      'local sidecar output should flow through a strict-prefix bounded streaming writer'
    )
    assertCondition(
      decoded.includes("Set-Variable -Scope Global -Name '__GyShell_InternalRecordOutcome'") &&
        decoded.includes(';& $global:__GyShell_InternalRecordOutcome ([bool]$?)') &&
        decoded.includes('$__GyShell_InternalUserCommandBlock=[scriptblock]::Create(') &&
        decoded.includes('$global:__gyshell_user_outcome_sampled=$true') &&
        !decoded.includes('if($_ -is [Management.Automation.ErrorRecord]){[string]$_}else{$_}') &&
        decoded.includes('$global:__gyshell_user_exception | Microsoft.PowerShell.Utility\\Out-String'),
      'the sidecar must sample status through a stable diagnostic entry while retaining structured PowerShell error details'
    )
    const rawStartIndex = decoded.indexOf(
      "__gyshell_emit_raw_boundary 'preexec' $__gyshell_request_id"
    )
    const commandExecutionIndex = decoded.indexOf(
      '$global:__gyshell_output_observed=[int64]0',
      rawStartIndex
    )
    const rawFinallyIndex = decoded.indexOf(
      "finally{__gyshell_emit_raw_boundary 'preend' $__gyshell_request_id}",
      commandExecutionIndex
    )
    assertCondition(
      rawStartIndex >= 0 &&
        commandExecutionIndex > rawStartIndex &&
        rawFinallyIndex > commandExecutionIndex &&
        decoded.slice(rawStartIndex, commandExecutionIndex).includes(';try{'),
      'raw output attribution must close in finally even when user control flow escapes the command block'
    )
    assertCondition(
      decoded.includes('[Management.Automation.Language.Parser]::ParseInput($__gyshell_cmd') &&
        decoded.indexOf('[Management.Automation.Language.Parser]::ParseInput($__gyshell_cmd') <
          decoded.indexOf('[scriptblock]::Create($__gyshell_instrumented_cmd)') &&
        decoded.includes("@('DynamicParamBlock','BeginBlock','ProcessBlock','EndBlock','CleanBlock')") &&
        decoded.includes('$__gyshell_named_block.Extent.EndOffset-1') &&
        decoded.includes('$__gyshell_cmd.Substring(0,$__gyshell_insert_offset)+[Environment]::NewLine+$__gyshell_outcome_footer'),
      'the exact user source must be parsed before ordinary or named-block-aware instrumentation is applied'
    )
    assertCondition(
      decoded.includes("$__has_native_error=$__has_new_error -and (([string]$__error_ref.FullyQualifiedErrorId) -like 'NativeCommandError*')") &&
        decoded.includes('$__returned_without_sample=$__gyshell_has_request -and -not $global:__gyshell_user_outcome_sampled -and -not $__user_threw') &&
        decoded.includes('if($__returned_without_sample){$__outcome_known=$false;1}elseif($__ok){0}elseif($__user_threw){1}elseif($__has_native_error){$__outcome_known=$false;') &&
        decoded.includes('elseif($__native -is [int] -and $__native -ne 0){$__outcome_known=$false;$__native}else{1}') &&
        decoded.includes('$global:__gyshell_user_ok=$false;$global:__gyshell_user_native=$LASTEXITCODE') &&
        !decoded.includes('$global:__gyshell_user_ok=$?'),
      'only sampled non-native outcomes should remain exact while native attribution and unsampled control flow fail closed'
    )
    assertCondition(
      decoded.includes("';request_id='") &&
        decoded.includes("';outcome_known='") &&
        decoded.includes("';output_bytes='") &&
        decoded.includes("';retained_bytes='") &&
        decoded.includes("';output_truncated='"),
      'the prompt marker must publish request identity and verifiable output metadata'
    )
    assertCondition(
      decoded.includes("$__gyshell_request_raw.Substring(33,1) -match '^[pc]$'") &&
        decoded.includes("$global:__gyshell_completed_request_kind=$__gyshell_request_kind") &&
        decoded.includes("if(-not $__gyshell_has_request -or $__gyshell_request_kind -eq 'c')") &&
        decoded.includes('$global:__gyshell_logical_user_ok=[bool]$__ok') &&
        decoded.includes("Write-Error 'GyShell status restoration sentinel' -ErrorAction Ignore"),
      'typed probes must not replace the user-visible PowerShell status restored for the real request'
    )
    assertCondition(
      !decoded.includes('__gyshell_should_native_fallback') &&
        !decoded.includes('cmd.exe /q /d /s /c') &&
        !decoded.includes('$__gyshell_capture_path') &&
        !decoded.includes('Get-Content -LiteralPath $__gyshell_capture_path -Raw'),
      'the sidecar must neither replay the command nor materialize an unbounded capture file'
    )
    assertCondition(
      !decoded.includes('$global:LASTEXITCODE=0'),
      'local sidecar prompt should preserve the shell-visible LASTEXITCODE variable'
    )
    assertCondition(
      !decoded.includes('__GYSHELL_TASK_FINISH__::ec=$ec'),
      'local sidecar prompt should not print visible finish markers'
    )
    assertCondition(
      decoded.includes("Set-Item -Path Function:\\Global:prompt") &&
        decoded.includes("-Options 'AllScope,ReadOnly'"),
      'the managed sidecar prompt should resist accidental replacement by user commands'
    )

    fs.rmSync(tracking.tmpPath, { recursive: true, force: true })
  })

  await runCase('modern local windows powershell sessions prefer bounded sidecar tracking with a short loader', async () => {
    const backend = new NodePtyBackend()
    const runtimeToken = 'abcdef0123456789abcdef0123456789'
    const privatePrefix = `__gyshell_${runtimeToken}`
    const tracking = (backend as any).resolveWindowsShellTracking('powershell.exe', '10.0.17763')
    let integrationTmpPath: string | undefined
    try {
      assertEqual(
        tracking.commandTrackingMode,
        'windows-powershell-sidecar',
        'modern local PowerShell should use the exact hidden output channel when it is available'
      )
      assertCondition(
        typeof tracking.tmpPath === 'string' &&
          typeof tracking.promptMarkerPath === 'string' &&
          typeof tracking.commandRequestPath === 'string' &&
          typeof tracking.commandOutputPath === 'string',
        'modern sidecar selection should allocate every private tracking path'
      )

      const integration = (backend as any).buildShellIntegration(
        'powershell.exe',
        runtimeToken
      ) as {
        args: string[]
        tmpPath: string
        commandTrackingMode: string
      }
      integrationTmpPath = integration.tmpPath
      assertEqual(
        integration.commandTrackingMode,
        'windows-powershell-sidecar',
        'the launched modern runtime should retain sidecar tracking mode'
      )
      const encodedIndex = integration.args.indexOf('-EncodedCommand')
      const loaderEncoded = integration.args[encodedIndex + 1] as string
      const loader = Buffer.from(loaderEncoded, 'base64').toString('utf16le')
      const bootstrapPath = path.join(integration.tmpPath, 'bootstrap.ps1')
      const bootstrap = fs.readFileSync(bootstrapPath, 'utf8').replace(/^\ufeff/, '')

      assertCondition(
        encodedIndex >= 0 && loaderEncoded.length < 8_000,
        'Windows CreateProcess should receive a bounded loader instead of the full sidecar program'
      )
      assertCondition(
        loader.includes('[Convert]::FromBase64String') &&
          loader.includes('. $__gyshell_bootstrap_path') &&
          !loader.includes('Out-String -Stream'),
        'the short loader should only decode and dot-source the private bootstrap path'
      )
      assertCondition(
        bootstrap.includes(`[Console]::InputEncoding=$${privatePrefix}_utf8`) &&
          bootstrap.includes(`function Global:${privatePrefix}_emit_raw_boundary`) &&
          bootstrap.includes(`]1337;gyshell_${runtimeToken}_`) &&
          bootstrap.includes(`${privatePrefix}_emit_raw_boundary 'preexec'`) &&
          bootstrap.includes(`${privatePrefix}_emit_raw_boundary 'preend'`),
        'the uploaded bootstrap should install UTF-8 capture and request-bound raw frames in the runtime-private namespace'
      )
      assertCondition(
        integration.args.includes('-ExecutionPolicy') && integration.args.includes('Bypass'),
        'the private bootstrap file should not be blocked by the host execution policy'
      )
    } finally {
      if (tracking.tmpPath) {
        fs.rmSync(tracking.tmpPath, { recursive: true, force: true })
      }
      if (integrationTmpPath) {
        fs.rmSync(integrationTmpPath, { recursive: true, force: true })
      }
    }
  })

  await runCase('Unix-hosted pwsh declares the same explicit sidecar lifecycle', () => {
    const backend = new NodePtyBackend() as any
    const runtimeToken = 'fedcba9876543210fedcba9876543210'
    const integration = backend.buildShellIntegration(
      '/opt/homebrew/bin/pwsh',
      runtimeToken
    ) as {
      args: string[]
      tmpPath?: string
      commandTrackingMode?: string
    }
    try {
      assertEqual(
        integration.commandTrackingMode,
        'windows-powershell-sidecar',
        'PowerShell Core command lifecycle must not depend on the host OS',
      )
      backend.commandTrackingModeByPtyId.set(
        'pty-unix-pwsh',
        integration.commandTrackingMode,
      )
      backend.commandShellFamilyByPtyId.set('pty-unix-pwsh', 'powershell')
      assertEqual(
        backend.getCommandTrackingMode('pty-unix-pwsh'),
        'windows-powershell-sidecar',
        'TerminalService needs an OS-independent sidecar capability signal',
      )
      assertEqual(
        backend.getCommandShellFamily('pty-unix-pwsh'),
        'powershell',
        'PowerShell lifecycle must be declared independently from Unix host semantics',
      )
      assertCondition(
        integration.args.includes('-EncodedCommand') &&
          typeof integration.tmpPath === 'string',
        'Unix-hosted pwsh should receive the private bounded bootstrap',
      )
    } finally {
      if (integration.tmpPath) {
        fs.rmSync(integration.tmpPath, { recursive: true, force: true })
      }
    }
  })

  await runCase('windows sidecar helper state is private to one runtime', () => {
    const backend = new NodePtyBackend()
    const runtimeToken = '1023456789abcdef1023456789abcdef'
    const privatePrefix = `__gyshell_${runtimeToken}`
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand(
      'windows-powershell-sidecar',
      'C:/Temp/prompt.log',
      'C:/Temp/request.b64',
      'C:/Temp/output.txt',
      runtimeToken
    ) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    assertCondition(
      decoded.includes(`function Global:${privatePrefix}_capture_text`) &&
        decoded.includes(`[scriptblock]::Create($${privatePrefix}_instrumented_cmd)`) &&
        decoded.includes("Set-Variable -Scope Global -Name '__GyShell_InternalRecordOutcome'") &&
        decoded.includes(`$global:${privatePrefix}_output_observed`),
      'sidecar command and capture state must share the runtime namespace while the diagnostic recorder stays stable'
    )
    assertCondition(
      decoded.includes(buildInitializationReadyMarker(runtimeToken)),
      'the PowerShell bootstrap completion marker must be scoped to this runtime'
    )
    assertCondition(
      !decoded.includes('function Global:__gyshell_capture_text') &&
        !decoded.includes('$global:__gyshell_output_observed'),
      'tokenized sidecars must not retain fixed helper identifiers'
    )
    assertEqual(
      (decoded.match(new RegExp(`\\[scriptblock\\]::Create\\(\\$${privatePrefix}_instrumented_cmd\\)`, 'g')) || [])
        .length,
      1,
      'tokenized sidecars must still contain exactly one user-command invocation'
    )
    assertCondition(
      decoded.includes("Set-Variable -Scope Global -Name '__GyShell_InternalDispatch'") &&
        decoded.includes("[scriptblock]::Create(@'") &&
        decoded.includes(
          `if($NestedPromptLevel -eq 0 -and -not $global:${privatePrefix}_completion_pending -and -not $global:${privatePrefix}_dispatch_active)`
        ) &&
        decoded.includes(`$global:${privatePrefix}_dispatch_active=$true;try{`) &&
        decoded.includes(`finally{$global:${privatePrefix}_dispatch_active=$false}`) &&
        decoded.indexOf(`if($NestedPromptLevel -eq 0`) <
          decoded.indexOf('[IO.File]::ReadAllText'),
      'the stable diagnostic dispatcher must reject nested and reentrant calls before touching request state and always release its runtime-private guard'
    )
    assertCondition(
      decoded.includes(
        `finally{${privatePrefix}_emit_raw_boundary 'preend' $${privatePrefix}_request_id}`
      ),
      'runtime-private raw attribution must close from a finally block'
    )
    assertCondition(
      decoded.indexOf(`[scriptblock]::Create($${privatePrefix}_instrumented_cmd)`) <
        decoded.indexOf('Set-Item -Path Function:\\Global:prompt') &&
        decoded.includes('Microsoft.PowerShell.Utility\\Out-String') &&
        decoded.includes('Microsoft.PowerShell.Core\\ForEach-Object'),
      'user execution must live outside prompt scope and use module-qualified capture commands'
    )
    assertCondition(
      !decoded.includes('$global:ProgressPreference=') &&
        decoded.includes(`[IO.File]::Move($${privatePrefix}_request_marker_tmp,$${privatePrefix}_request_marker)`) &&
        decoded.indexOf(`$global:${privatePrefix}_completion_pending=$true`) <
          decoded.indexOf('[IO.File]::AppendAllText') &&
        decoded.indexOf('[IO.File]::AppendAllText') <
          decoded.indexOf(`[IO.File]::Move($${privatePrefix}_request_marker_tmp`),
      'the dispatcher must preserve user preference state and publish the request-specific marker as the final commit record'
    )
    assertEqual(
      buildWindowsPowerShellDispatchInput(runtimeToken),
      '. $global:__GyShell_InternalDispatch',
      'the backend trigger must dot-source the stable diagnostic dispatcher without exposing the runtime token'
    )
  })

  await runCase('sidecar path data is never rewritten as a private helper identifier', () => {
    const backend = new NodePtyBackend()
    const runtimeToken = '2023456789abcdef2023456789abcdef'
    const markerPath = 'C:/Users/__gyshell/AppData/Local/Temp/prompt.log'
    const requestPath = 'C:/Users/__gyshell/AppData/Local/Temp/request.b64'
    const outputPath = 'C:/Users/__gyshell/AppData/Local/Temp/output.txt'
    const encoded = (backend as any).buildWindowsPowerShellEncodedCommand(
      'windows-powershell-sidecar',
      markerPath,
      requestPath,
      outputPath,
      runtimeToken
    ) as string
    const decoded = Buffer.from(encoded, 'base64').toString('utf16le')

    for (const originalPath of [markerPath, requestPath, outputPath]) {
      const pathBase64 = Buffer.from(originalPath, 'utf8').toString('base64')
      assertCondition(
        decoded.includes(`FromBase64String('${pathBase64}')`),
        `the generated script should deserialize the original path exactly: ${originalPath}`
      )
    }
    assertCondition(
      !decoded.includes(`C:/Users/__gyshell_${runtimeToken}`),
      'identifier namespacing must never rewrite serialized path data'
    )
  })

  await runCase('cleanupTempArtifacts removes local sidecar temp directories and tracking state', async () => {
    const backend = new NodePtyBackend() as any
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-nodepty-cleanup-'))
    const markerPath = path.join(tmpDir, 'prompt-marker.log')
    fs.writeFileSync(markerPath, 'marker\n', 'utf8')

    backend.tmpPathsByPtyId.set('pty-clean', tmpDir)
    backend.promptMarkerPathByPtyId.set('pty-clean', markerPath)
    backend.commandRequestPathByPtyId.set('pty-clean', path.join(tmpDir, 'exec-request.b64'))
    backend.commandOutputPathByPtyId.set('pty-clean', path.join(tmpDir, 'exec-output.txt'))
    backend.commandTrackingModeByPtyId.set('pty-clean', 'windows-powershell-sidecar')
    backend.promptMarkerStateByPtyId.set('pty-clean', { sequence: 1, exitCode: 0 })

    backend.cleanupTempArtifacts('pty-clean')

    assertEqual(fs.existsSync(tmpDir), false, 'cleanup should remove the temp directory recursively')
    assertEqual(backend.promptMarkerPathByPtyId.has('pty-clean'), false, 'cleanup should clear prompt marker state')
    assertEqual(backend.commandRequestPathByPtyId.has('pty-clean'), false, 'cleanup should clear request-file tracking state')
    assertEqual(backend.commandOutputPathByPtyId.has('pty-clean'), false, 'cleanup should clear output-file tracking state')
    assertEqual(backend.commandTrackingModeByPtyId.has('pty-clean'), false, 'cleanup should clear command tracking mode')
    assertEqual(backend.promptMarkerStateByPtyId.has('pty-clean'), false, 'cleanup should clear cached marker data')
  })

  await runCase('an old local exit cannot erase replacement state created by its callback', async () => {
    const backend = new NodePtyBackend() as any
    const terminalId = 'nodepty-exit-replacement-race'
    await backend.spawn({
      type: 'local',
      id: terminalId,
      title: 'Node PTY Exit Replacement Race',
      cols: 80,
      rows: 24
    })

    const replacementInstance = {
      pty: {
        kill: () => {},
        write: () => {},
        resize: () => {}
      },
      dataCallbacks: new Set(),
      exitCallbacks: new Set(),
      pendingData: '',
      buffer: ''
    }
    let exitResolved: () => void = () => {}
    const exitObserved = new Promise<void>((resolve) => {
      exitResolved = resolve
    })
    backend.onExit(terminalId, () => {
      // TerminalService performs local auto-restart synchronously from this
      // callback. Model that replacement without creating a second real PTY.
      backend.ptys.set(terminalId, replacementInstance)
      backend.commandProtocolAvailabilityByPtyId.set(terminalId, true)
      exitResolved()
    })

    backend.write(terminalId, 'exit\n')
    await Promise.race([
      exitObserved,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for local PTY exit')), 5000)
      )
    ])
    await Promise.resolve()

    assertEqual(
      backend.ptys.get(terminalId),
      replacementInstance,
      'old exit cleanup must not delete the replacement PTY registration'
    )
    assertEqual(
      backend.commandProtocolAvailabilityByPtyId.get(terminalId),
      true,
      'old exit cleanup must not delete replacement protocol state'
    )
    backend.kill(terminalId)
  })

  await runCase('local command protocol capability fails closed for unsupported shells', () => {
    const backend = new NodePtyBackend() as any
    assertEqual(
      backend.shellSupportsCommandProtocol('/bin/zsh'),
      true,
      'zsh should advertise verified command boundaries'
    )
    assertEqual(
      backend.shellSupportsCommandProtocol('/bin/bash'),
      true,
      'bash should advertise verified command boundaries'
    )
    assertEqual(
      backend.shellSupportsCommandProtocol('/usr/local/bin/fish'),
      false,
      'shells without installed boundaries must not claim exec_command support'
    )
    assertEqual(
      backend.resolveCommandShellFamily('C:/Program Files/Git/bin/bash.exe'),
      'unix',
      'Windows-hosted Bash should declare Unix command lifecycle semantics',
    )
    assertEqual(
      backend.resolveCommandShellFamily('/opt/homebrew/bin/pwsh'),
      'powershell',
      'Unix-hosted PowerShell should declare PowerShell command lifecycle semantics',
    )
    assertEqual(
      backend.resolveCommandShellFamily('C:/tools/fish.exe'),
      undefined,
      'unsupported shells should not acquire a lifecycle family from their host OS',
    )
  })

  await runCase('local Unix shell integration namespaces markers and hook state per runtime', () => {
    const backend = new NodePtyBackend() as any
    const runtimeToken = '0123456789abcdef0123456789abcdef'
    const integration = backend.buildShellIntegration('/bin/bash', runtimeToken)
    const rcPath = integration.args[2] as string
    const script = fs.readFileSync(rcPath, 'utf8')

    assertCondition(
      script.includes(`gyshell_${runtimeToken}_preexec`),
      'local shell markers should include the private runtime namespace'
    )
    assertCondition(
      script.includes(`__gyshell_${runtimeToken}_command_seq`),
      'local command sequence state should use a token-derived identifier'
    )
    assertCondition(
      script.includes(`__gyshell_${runtimeToken}_precmd`),
      'local hook functions should use token-derived identifiers'
    )
    assertCondition(
      !script.includes('__gyshell_command_seq') && !script.includes('__gyshell_precmd()'),
      'tokenized local scripts must not retain public fixed state or hook names'
    )
    assertCondition(
      script.includes(`__gyshell_${runtimeToken}_precmd_begin`) &&
        script.includes(`PROMPT_COMMAND=(__gyshell_${runtimeToken}_precmd_begin "\${PROMPT_COMMAND[@]}" __gyshell_${runtimeToken}_precmd)`) &&
        script.indexOf(`__gyshell_${runtimeToken}_precmd_begin`) <
          script.lastIndexOf(`__gyshell_${runtimeToken}_precmd`),
      'Bash must freeze outcome before user prompt hooks and publish its end marker last'
    )

    fs.rmSync(integration.tmpPath, { recursive: true, force: true })
  })

  await runCase('local zsh login profiles cannot silently remove command hooks', () => {
    const backend = new NodePtyBackend() as any
    const runtimeToken = '1123456789abcdef1123456789abcdef'
    const integration = backend.buildShellIntegration('/bin/zsh', runtimeToken)
    const zlogin = fs.readFileSync(path.join(integration.tmpPath, '.zlogin'), 'utf8')
    const zshrc = fs.readFileSync(path.join(integration.tmpPath, '.zshrc'), 'utf8')

    assertCondition(
      zlogin.includes(`add-zsh-hook preexec __gyshell_${runtimeToken}_preexec`) &&
        zlogin.includes(
          `precmd_functions=(__gyshell_${runtimeToken}_precmd_begin \${precmd_functions:#__gyshell_${runtimeToken}_precmd_begin})`
        ) &&
        zlogin.includes(
          `precmd_functions=(\${precmd_functions:#__gyshell_${runtimeToken}_precmd} __gyshell_${runtimeToken}_precmd)`
        ),
      'the post-profile login phase must keep exit capture first and completion publication last'
    )
    assertCondition(
      zshrc.includes(`__gyshell_${runtimeToken}_precmd_begin() { local prior=$?;`) &&
        zshrc.includes(
          `if [ "\${__gyshell_${runtimeToken}_dispatch_completion_ready-0}" != 1 ]; then __gyshell_${runtimeToken}_command_exit=$prior; fi;`
        ) &&
        zshrc.includes(
          `gyshell_${runtimeToken}_preend;seq=%s;nonce=%s`
        ),
      'the first zsh precmd hook must freeze status and close capture without overwriting dispatcher-sampled status'
    )
    fs.rmSync(integration.tmpPath, { recursive: true, force: true })
  })

  await runCase('prepareCommandTracking resets an unreadable local marker before dispatch', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-await-fresh', 'windows-powershell-sidecar')
    backend.promptMarkerPathByPtyId.set('pty-await-fresh', 'C:/Temp/prompt-marker.log')
    backend.commandRequestPathByPtyId.set('pty-await-fresh', 'C:/Temp/exec-request.b64')
    backend.commandOutputPathByPtyId.set('pty-await-fresh', 'C:/Temp/exec-output.txt')
    backend.refreshPromptMarkerState = async () => null
    backend.resetPromptMarkerFile = async () => true

    const token = await backend.prepareCommandTracking('pty-await-fresh')

    assertEqual(token?.baselineSequence, 0, 'missing local baselines should start from sequence zero')
    assertEqual(
      token?.awaitingInitialFreshMarker,
      undefined,
      'a successful reset should establish sequence zero without a wall-clock freshness mode'
    )
    assertEqual(token?.dispatchMode, 'prompt-file', 'local sidecar tokens should opt into prompt-file dispatch')
    assertEqual(
      token?.displayMode,
      'synthetic-transcript',
      'downlevel local prompt-file dispatch should opt into synthetic transcript rendering'
    )
    assertEqual(
      token?.commandOutputPath,
      'C:/Temp/exec-output.txt',
      'local sidecar tokens should carry the hidden output file path'
    )
  })

  await runCase('prepareCommandTracking truncates a readable marker journal after taking its sequence baseline', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-prepare-journal-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Admin', 'utf8').toString('base64')
    try {
      fs.writeFileSync(
        markerPath,
        `__GYSHELL_PROMPT__::seq=7;ec=0;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-readable-journal', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-readable-journal', markerPath)
      backend.commandRequestPathByPtyId.set('pty-readable-journal', path.join(tempDir, 'request.b64'))

      const token = await backend.prepareCommandTracking('pty-readable-journal')

      assertEqual(token?.baselineSequence, 7, 'preparation should retain the live monotonic sequence baseline')
      assertEqual(fs.readFileSync(markerPath, 'utf8'), '', 'preparation should bound the append-only journal per command')
      assertEqual(
        backend.promptMarkerStateByPtyId.has('pty-readable-journal'),
        false,
        'journal reset should also discard the cached pre-reset marker'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('stale local preparation cannot reset a replacement runtime after marker read', async () => {
    const backend = new NodePtyBackend() as any
    const ptyId = 'pty-prepare-read-race'
    const oldInstance = { runtime: 'old' }
    const replacementInstance = { runtime: 'replacement' }
    const oldMarkerPath = '/tmp/old-prompt-marker.log'
    const replacementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-prepare-read-race-'))
    const replacementMarkerPath = path.join(replacementDir, 'prompt-marker.log')
    fs.writeFileSync(replacementMarkerPath, 'replacement-marker', 'utf8')
    let releaseRead: () => void = () => {}
    let markReadStarted: () => void = () => {}
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    let resetCalls = 0

    backend.ptys.set(ptyId, oldInstance)
    backend.commandTrackingModeByPtyId.set(ptyId, 'windows-powershell-sidecar')
    backend.promptMarkerPathByPtyId.set(ptyId, oldMarkerPath)
    backend.commandRequestPathByPtyId.set(ptyId, '/tmp/old-request.b64')
    backend.commandOutputPathByPtyId.set(ptyId, '/tmp/old-output.txt')
    backend.commandProtocolTokenByPtyId.set(ptyId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    backend.refreshPromptMarkerState = async () => {
      markReadStarted()
      await readGate
      return { sequence: 7, exitCode: 0 }
    }
    backend.resetPromptMarkerFile = async () => {
      resetCalls += 1
      return true
    }

    try {
      const preparing = backend.prepareCommandTracking(ptyId)
      await readStarted
      backend.ptys.set(ptyId, replacementInstance)
      backend.promptMarkerPathByPtyId.set(ptyId, replacementMarkerPath)
      backend.commandRequestPathByPtyId.set(ptyId, '/tmp/new-request.b64')
      backend.commandOutputPathByPtyId.set(ptyId, '/tmp/new-output.txt')
      backend.commandProtocolTokenByPtyId.set(ptyId, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
      releaseRead()
      const outcome = await Promise.allSettled([preparing])

      assertEqual(outcome[0]?.status, 'rejected', 'stale preparation must reject after runtime replacement')
      assertEqual(resetCalls, 0, 'stale preparation must not reset any path after detecting replacement')
      assertEqual(
        fs.readFileSync(replacementMarkerPath, 'utf8'),
        'replacement-marker',
        'the replacement marker must remain untouched'
      )
    } finally {
      fs.rmSync(replacementDir, { recursive: true, force: true })
    }
  })

  await runCase('stale local reset uses its captured path and cannot clear replacement cache', async () => {
    const backend = new NodePtyBackend() as any
    const ptyId = 'pty-prepare-reset-race'
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-old-reset-race-'))
    const replacementDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-new-reset-race-'))
    const oldMarkerPath = path.join(oldDir, 'prompt-marker.log')
    const replacementMarkerPath = path.join(replacementDir, 'prompt-marker.log')
    fs.writeFileSync(oldMarkerPath, 'old-marker', 'utf8')
    fs.writeFileSync(replacementMarkerPath, 'replacement-marker', 'utf8')
    let releaseReset: () => void = () => {}
    let markResetStarted: () => void = () => {}
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve
    })
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve
    })
    const oldInstance = { runtime: 'old' }
    const replacementInstance = { runtime: 'replacement' }

    backend.ptys.set(ptyId, oldInstance)
    backend.commandTrackingModeByPtyId.set(ptyId, 'windows-powershell-sidecar')
    backend.promptMarkerPathByPtyId.set(ptyId, oldMarkerPath)
    backend.commandRequestPathByPtyId.set(ptyId, path.join(oldDir, 'request.b64'))
    backend.commandOutputPathByPtyId.set(ptyId, path.join(oldDir, 'output.txt'))
    backend.commandProtocolTokenByPtyId.set(ptyId, 'cccccccccccccccccccccccccccccccc')
    backend.refreshPromptMarkerState = async () => ({ sequence: 3, exitCode: 0 })
    backend.resetPromptMarkerFile = async (_currentPtyId: string, capturedPath: string) => {
      markResetStarted()
      await resetGate
      fs.writeFileSync(capturedPath, '', 'utf8')
      return true
    }

    try {
      const preparing = backend.prepareCommandTracking(ptyId)
      await resetStarted
      backend.ptys.set(ptyId, replacementInstance)
      backend.promptMarkerPathByPtyId.set(ptyId, replacementMarkerPath)
      backend.commandRequestPathByPtyId.set(ptyId, path.join(replacementDir, 'request.b64'))
      backend.commandOutputPathByPtyId.set(ptyId, path.join(replacementDir, 'output.txt'))
      backend.commandProtocolTokenByPtyId.set(ptyId, 'dddddddddddddddddddddddddddddddd')
      backend.promptMarkerStateByPtyId.set(ptyId, { sequence: 11, exitCode: 0 })
      releaseReset()
      const outcome = await Promise.allSettled([preparing])

      assertEqual(outcome[0]?.status, 'rejected', 'a reset that outlives its runtime must not return a mixed token')
      assertEqual(fs.readFileSync(oldMarkerPath, 'utf8'), '', 'only the captured old path may be reset')
      assertEqual(
        fs.readFileSync(replacementMarkerPath, 'utf8'),
        'replacement-marker',
        'the replacement path must not be re-resolved by stale preparation'
      )
      assertEqual(
        backend.promptMarkerStateByPtyId.get(ptyId)?.sequence,
        11,
        'stale reset completion must not erase replacement marker cache'
      )
    } finally {
      fs.rmSync(oldDir, { recursive: true, force: true })
      fs.rmSync(replacementDir, { recursive: true, force: true })
    }
  })

  await runCase('prepareCommandTracking never reuses cached local state when live reset fails', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-cached-local', 'windows-powershell-sidecar')
    backend.promptMarkerStateByPtyId.set('pty-cached-local', { sequence: 9, exitCode: 0 })
    backend.refreshPromptMarkerState = async () => null
    backend.resetPromptMarkerFile = async () => false

    const outcome = await Promise.allSettled([
      backend.prepareCommandTracking('pty-cached-local')
    ])

    assertEqual(
      outcome[0]?.status,
      'rejected',
      'an unreadable and unresettable marker must fail closed instead of trusting cached state'
    )
  })

  await runCase('pollCommandTracking uses sequence freshness even when remote mtimes predate the client clock', async () => {
    const backend = new NodePtyBackend() as any
    backend.commandTrackingModeByPtyId.set('pty-stale-local', 'windows-powershell-sidecar')
    backend.refreshPromptMarkerState = async () => ({
      sequence: 5,
      exitCode: 0,
      cwd: 'C:/Windows',
      homeDir: 'C:/Users/Administrator',
      modifiedAtMs: 1000
    })

    const token = {
      mode: 'windows-powershell-sidecar',
      baselineSequence: 4,
      awaitingInitialFreshMarker: true,
      dispatchedAtMs: 9000000000000
    } as any

    const fresh = await backend.pollCommandTracking('pty-stale-local', token)

    assertEqual(fresh?.sequence, 5, 'a greater sequence should finish regardless of cross-machine wall clocks')
    assertEqual(token.awaitingInitialFreshMarker, false, 'legacy freshness flags should be retired after a sequenced marker')
  })

  await runCase('cleanupStaleWindowsSidecarTempDirs prunes abandoned temp directories from old runs', async () => {
    const backend = new NodePtyBackend() as any
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-winps-stale-'))
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-winps-fresh-'))
    const staleTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)

    fs.utimesSync(staleDir, staleTime, staleTime)
    backend.hasScannedWindowsSidecarTempDirs = false
    backend.cleanupStaleWindowsSidecarTempDirs()

    assertEqual(fs.existsSync(staleDir), false, 'stale sidecar temp directories should be removed')
    assertEqual(fs.existsSync(freshDir), true, 'recent sidecar temp directories should be kept')

    fs.rmSync(freshDir, { recursive: true, force: true })
  })

  await runCase('windows sidecar output reads are bounded and never split a UTF-8 scalar', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-output-bound-'))
    const outputPath = path.join(tempDir, 'command-output.txt')
    const prefix = 'a'.repeat(COMMAND_CAPTURE_MAX_UTF8_BYTES - 1)
    const source = `${prefix}😀tail`

    try {
      fs.writeFileSync(outputPath, source, 'utf8')
      const output = await backend.readCommandOutputFile(outputPath)

      assertEqual(
        output?.observedUtf8Bytes,
        Buffer.byteLength(source, 'utf8'),
        'sidecar metadata should preserve the full observed file size'
      )
      assertEqual(output?.truncated, true, 'oversized sidecar files should report truncation')
      assertEqual(
        Buffer.byteLength(output?.text || '', 'utf8'),
        COMMAND_CAPTURE_MAX_UTF8_BYTES - 1,
        'the retained prefix should stop before a scalar that crosses the byte limit'
      )
      assertCondition(
        !(output?.text || '').includes('\ufffd'),
        'a byte boundary must not introduce a Unicode replacement character'
      )

      const leadingByteOrderMark = '\ufeffVISIBLE'
      fs.writeFileSync(outputPath, leadingByteOrderMark, 'utf8')
      const leadingOutput = await backend.readCommandOutputFile(outputPath)
      assertEqual(
        leadingOutput?.text,
        leadingByteOrderMark,
        'the sidecar writes raw UTF-8, so a leading U+FEFF is command output rather than a removable file BOM'
      )
      assertEqual(
        leadingOutput?.observedUtf8Bytes,
        Buffer.byteLength(leadingByteOrderMark, 'utf8'),
        'leading U+FEFF bytes must remain part of the verified transcript length'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('local sidecar polling prefers generator-observed truncation metadata', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-marker-output-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const outputPath = path.join(tempDir, 'command-output.txt')
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Administrator', 'utf8').toString('base64')

    try {
      fs.writeFileSync(outputPath, 'retained', 'utf8')
      fs.writeFileSync(
        markerPath,
        `__GYSHELL_PROMPT__::seq=1;ec=0;output_bytes=33554432;retained_bytes=8;output_truncated=1;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-marker-metadata', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-marker-metadata', markerPath)
      backend.commandOutputPathByPtyId.set('pty-marker-metadata', outputPath)

      const update = await backend.pollCommandTracking('pty-marker-metadata', {
        mode: 'windows-powershell-sidecar',
        baselineSequence: 0,
        commandOutputPath: outputPath,
        expectCommandOutput: true,
      })

      assertEqual(update?.output, 'retained', 'polling should return the retained sidecar prefix')
      assertEqual(
        update?.outputObservedUtf8Bytes,
        33554432,
        'polling should propagate the generator count rather than the retained file size'
      )
      assertEqual(
        update?.outputTruncated,
        true,
        'polling should preserve the generator truncation flag'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('local sidecar polling finds its request-bound completion before later unrelated markers', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-marker-journal-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const outputPath = path.join(tempDir, 'command-output.txt')
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Administrator', 'utf8').toString('base64')
    const expectedRequestId = '0123456789abcdef0123456789abcdef'
    const unrelatedRequestId = 'fedcba9876543210fedcba9876543210'

    try {
      fs.writeFileSync(outputPath, 'owned', 'utf8')
      fs.writeFileSync(
        markerPath,
        [
          `__GYSHELL_PROMPT__::seq=1;ec=7;request_id=${expectedRequestId};output_bytes=5;retained_bytes=5;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`,
          `__GYSHELL_PROMPT__::seq=2;ec=0;request_id=${unrelatedRequestId};output_bytes=0;retained_bytes=0;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}`,
          '',
        ].join('\n'),
        'utf8'
      )
      fs.writeFileSync(
        `${markerPath}.${expectedRequestId}`,
        `__GYSHELL_PROMPT__::seq=1;ec=7;request_id=${expectedRequestId};output_bytes=5;retained_bytes=5;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-marker-journal', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-marker-journal', markerPath)
      backend.commandOutputPathByPtyId.set('pty-marker-journal', outputPath)

      const update = await backend.pollCommandTracking('pty-marker-journal', {
        mode: 'windows-powershell-sidecar',
        baselineSequence: 0,
        expectedRequestId,
        commandOutputPath: outputPath,
        expectCommandOutput: true,
      })

      assertEqual(update?.sequence, 1, 'the request-bound marker should survive a later unrelated prompt')
      assertEqual(update?.requestId, expectedRequestId, 'polling must return only the expected request identity')
      assertEqual(update?.output, 'owned', 'the matched request should retain its owned transcript')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('local sidecar polling rejects a truncated marker whose retained file is short', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-short-retained-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const outputPath = path.join(tempDir, 'command-output.txt')
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Administrator', 'utf8').toString('base64')

    try {
      fs.writeFileSync(outputPath, 'short', 'utf8')
      fs.writeFileSync(
        markerPath,
        `__GYSHELL_PROMPT__::seq=1;ec=0;output_bytes=100000000;retained_bytes=8;output_truncated=1;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-short-retained', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-short-retained', markerPath)
      backend.commandOutputPathByPtyId.set('pty-short-retained', outputPath)

      const outcome = await Promise.allSettled([
        backend.pollCommandTracking('pty-short-retained', {
          mode: 'windows-powershell-sidecar',
          baselineSequence: 0,
          commandOutputPath: outputPath,
          expectCommandOutput: true,
        })
      ])

      assertEqual(
        outcome[0]?.status,
        'rejected',
        'truncation must not hide additional loss between the marker and retained file'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('local sidecar keeps an exact completion marker until decoded output is complete', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-local-short-decoded-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const outputPath = path.join(tempDir, 'command-output.txt')
    const requestId = '8123456789abcdef8123456789abcdef'
    const exactMarkerPath = `${markerPath}.${requestId}`
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Administrator', 'utf8').toString('base64')

    try {
      fs.writeFileSync(
        exactMarkerPath,
        `__GYSHELL_PROMPT__::seq=1;ec=0;request_id=${requestId};output_bytes=8;retained_bytes=8;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-local-short-decoded', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-local-short-decoded', markerPath)
      backend.commandOutputPathByPtyId.set('pty-local-short-decoded', outputPath)
      let outputReadCount = 0
      backend.readCommandOutputFile = async () => {
        outputReadCount += 1
        return {
          text: outputReadCount === 1 ? 'short' : '12345678',
          observedUtf8Bytes: 8,
          truncated: false,
        }
      }
      const token = {
        mode: 'windows-powershell-sidecar',
        baselineSequence: 0,
        expectedRequestId: requestId,
        commandOutputPath: outputPath,
        expectCommandOutput: true,
      } as const

      const first = await Promise.allSettled([
        backend.pollCommandTracking('pty-local-short-decoded', token)
      ])
      assertEqual(first[0]?.status, 'rejected', 'decoded local output loss must fail before commit acknowledgement')
      assertEqual(fs.existsSync(exactMarkerPath), true, 'the retryable local completion marker must remain after validation failure')

      const recovered = await backend.pollCommandTracking('pty-local-short-decoded', token)
      assertEqual(recovered?.output, '12345678', 'the next complete local read should recover the same completion')
      assertEqual(fs.existsSync(exactMarkerPath), false, 'the recovered completion marker should be acknowledged once')
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('local sidecar polling rejects a completion whose owned output file is unreadable', async () => {
    const backend = new NodePtyBackend() as any
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gyshell-missing-output-'))
    const markerPath = path.join(tempDir, 'prompt-marker.log')
    const outputPath = path.join(tempDir, 'missing-output.txt')
    const cwdB64 = Buffer.from('C:/Windows', 'utf8').toString('base64')
    const homeB64 = Buffer.from('C:/Users/Administrator', 'utf8').toString('base64')

    try {
      fs.writeFileSync(
        markerPath,
        `__GYSHELL_PROMPT__::seq=1;ec=0;output_bytes=3;retained_bytes=3;output_truncated=0;cwd_b64=${cwdB64};home_b64=${homeB64}\n`,
        'utf8'
      )
      backend.commandTrackingModeByPtyId.set('pty-missing-output', 'windows-powershell-sidecar')
      backend.promptMarkerPathByPtyId.set('pty-missing-output', markerPath)
      backend.commandOutputPathByPtyId.set('pty-missing-output', outputPath)

      const outcome = await Promise.allSettled([
        backend.pollCommandTracking('pty-missing-output', {
          mode: 'windows-powershell-sidecar',
          baselineSequence: 0,
          commandOutputPath: outputPath,
          expectCommandOutput: true,
        })
      ])

      assertEqual(
        outcome[0]?.status,
        'rejected',
        'a completion marker must not turn an unreadable owned output file into empty success'
      )
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  await runCase('execOnSession passes stdin to child process via spawn', async () => {
    const backend = new NodePtyBackend()
    // Use /bin/sh on unix, powershell on win — the standard invocation reads from stdin with "cat" / "-Command -"
    const isWin = os.platform() === 'win32'
    const command = isWin ? '-' : 'cat'
    // Build a minimal stdin payload that produces deterministic output
    const payload = isWin ? "Write-Output 'STDIN_OK'\r\n" : 'echo STDIN_OK\n'

    // We call execOnSession with stdin — prior to the fix this would be silently ignored
    const result = await backend.execOnSession('test-stdin', command, 5000, { stdin: payload })

    assertCondition(result !== null, 'execOnSession with stdin should not return null')
    assertCondition(
      result!.stdout.includes('STDIN_OK'),
      `stdout should contain the text written via stdin, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })

  await runCase('execOnSession without stdin still works via execFile path', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    const command = isWin ? "Write-Output 'NO_STDIN'" : "echo NO_STDIN"

    const result = await backend.execOnSession('test-no-stdin', command, 5000)

    assertCondition(result !== null, 'execOnSession without stdin should still work')
    assertCondition(
      result!.stdout.includes('NO_STDIN'),
      `stdout should contain echo output, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })

  await runCase('execOnSession with stdin returns null on timeout instead of hanging', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    // A command that blocks forever reading stdin — we send no stdin terminator
    const command = isWin ? '-' : 'cat'

    // Use a very short timeout to verify it doesn't hang
    const result = await backend.execOnSession(
      'test-stdin-timeout',
      command,
      500,
      { stdin: '' }  // empty stdin but the command expects more — should timeout
    )

    // On some systems the empty stdin causes immediate EOF and cat exits.
    // Either null (timeout) or empty output are acceptable — the key test is it doesn't hang.
    assertCondition(
      result === null || result.stdout.length === 0,
      'timed-out or empty stdin should not produce unexpected output'
    )
  })

  await runCase('execOnSession with stdin handles large payloads', async () => {
    const backend = new NodePtyBackend()
    const isWin = os.platform() === 'win32'
    // Simulate the ~6KB PowerShell monitor script size
    const marker = 'LARGE_PAYLOAD_OK'
    const padding = 'x'.repeat(6000)
    const command = isWin ? '-' : 'cat'
    const payload = isWin
      ? `$null='${padding}'; Write-Output '${marker}'\r\n`
      : `# ${padding}\necho ${marker}\n`

    const result = await backend.execOnSession('test-large-stdin', command, 10000, { stdin: payload })

    assertCondition(result !== null, 'large stdin payload should not cause failure')
    assertCondition(
      result!.stdout.includes(marker),
      `large stdin payload should produce expected output, got: ${JSON.stringify(result!.stdout.slice(0, 200))}`
    )
  })
}

void run().catch((error) => {
  console.error(error)
  process.exit(1)
})
