# Terminal Views and History

GyShell offers two desktop terminal views. **Classic is the default**; **Block** is an opt-in view selected in Settings → Terminal or the terminal footer. The `terminal.viewMode` setting applies across a window's terminal panels and persists across restarts.

## One terminal, two views

Both views share the same xterm runtime, PTY stream, keyboard input, selection settings, font size, line height, theme, and scrollback configuration. Block output is a projection of xterm's parsed normal buffer, anchored by terminal Activities. It does not run a second terminal or parse a separate command stream.

- Classic displays the native terminal with command marks, a command navigator, and session dividers.
- Block displays command/output blocks above the real terminal prompt. Selecting a block expands it in place in narrow panels or opens a details pane in wide panels. The command navigator is hidden.
- The prompt dock is the real xterm, revealed through a bottom aperture (never a separate text field). While a command runs, the dock is that block's live tail: the block lists its rows only down to the dock's first row, so no row is shown twice. A short history sits directly on the dock. The dock itself never scrolls; the wheel over it scrolls the block stream (applications that track the mouse still receive it).
- Block follows new output until the user scrolls back, navigates to an older block, or selects text. Typing into the prompt or choosing “Jump to latest” resumes following.
- Alternate-screen applications use the native terminal. Initializing sessions retain the prompt dock; disconnected sessions hide it.

The desktop implementation is in `packages/ui/src/renderer_v2/components/Terminal/`:

| Module | Responsibility |
| --- | --- |
| `XTermView.tsx` and `terminalWriteCoordinator.ts` | Own the retained xterm runtime and ordered output replay/live writes. |
| `terminalActivityRuntime.ts` | Keep Activity updates and recovered metadata current, including while the React host is detached. |
| `useTerminalActivities.ts` and `terminalMarkerRegistry.ts` | Project Activities into buffer ranges and own/dispose Activity, session-boundary, and offset-anchor markers. |
| `block/` | Render blocks, output cells, details, follow behavior, and the dock aperture over the real xterm. |
| `terminalFontOptions.ts` | Resolve shared terminal font settings and measure xterm row height. |
| `TerminalSessionDividerOverlay.tsx` | Render localized session boundaries on reserved blank rows without covering terminal text. |

Presentation uses the application's theme tokens and xterm's active ANSI palette. Shared Activity, session-boundary, and connection-status models live in `packages/shared`; backend services do not depend on renderer code.

## Activities and connection state

`TerminalService` records manual shell commands and Agent commands as Activities with stable IDs, revisions, actors, execution status, timestamps, and absolute visible-stream offsets. Agent commands carry a concise `intent` label; older persisted tool calls without a label remain executable. Command transcripts retain their separate execution/capture contract for `read_command_output`.

Connection progress and failure are transient terminal metadata. Desktop connection cards and mobile monitoring show that state without inserting it into terminal output or saving it as history.

Desktop IPC exposes Activities and session boundaries for exact xterm marker placement. WebSocket clients can read Activities; mobile's read-only terminal monitor continues to use `terminal:getBufferDelta` and transient connection status. It does not implement desktop block layout or marker placement.

## Durable history and session resumption

`TerminalStateStore` saves tab configurations in `terminal-tabs-state.json`. `TerminalPersistenceStore` separately saves visible output, Activities, session boundaries, and Agent command records in `terminal-persistence.sqlite`. Electron and the standalone backend compose these stores in their respective startup code.

`terminal.saveHistory` defaults to `true`. Disabling it clears durable terminal history and stops new history writes; tab configuration persistence remains separate. Existing live terminal buffers are not cleared by the setting.

Persistence has distinct ownership and retention rules:

- Visible output is retained per terminal, bounded by UTF-8 bytes and segment count (defaults: 4 MiB and 4,096 segments). Restore loads a tail that fits the in-memory visible buffer. Offsets count JavaScript string units; storage budgets count UTF-8 bytes.
- Activities are retained per terminal with a target of 300 records; running Activities are protected from ordinary retention eviction.
- Closing a tab deletes its visible output, Activities, and session boundaries. Startup removes durable visible history for tabs absent from the saved tab list.
- Agent command records may outlive a tab because chat messages still reference their output. They have independent global capture and tombstone limits defined in `agentCommandRecord.ts`.

Visible output and command metadata are buffered and committed together in SQLite transactions. `TerminalService` flushes after a 120 ms quiet period, at a 1,000 ms maximum wait, or when queued output reaches 1 MiB. A failed transaction leaves its batch queued for retry, including metadata-only batches. Shutdown attempts a final flush and closes the store even if saving tab configuration fails.

Restoration replays retained output before admitting the new runtime's stream. Activities left running by an earlier process become `outcome-unknown`. `sessionResumePlan.ts` records a structured boundary and reserves blank rows for the desktop divider; the text “Session Resumed” is never injected into terminal bytes. Resuming again without intervening visible output reuses the previous boundary.

Lifecycle epochs fence asynchronous replay so a closed or replaced terminal cannot receive a stale restore. A stream rewind or gap rebases its durable visible history and removes offset-based metadata from the abandoned stream. A corrupt retained segment chain is discarded for that terminal; transient storage/replay failures preserve durable history and suspend persistence of the replacement stream. Startup quarantines a corrupt database and disables history for that launch; an unsupported newer schema is left untouched.

## Verification

Run from the repository root:

```sh
npm run typecheck:all
npm run test:terminal-block
npm run test:terminal-render-extreme
npm run test:backend-unit-extreme
npm run build:electron
npm run build:backend
npm run build:mobile-web
```

Focused standalone specs cover persistence rollback/retry, stream discontinuities, zero-length restores, retained Activity updates, marker ownership, session spacing, runtime replacement, and completed-command retention. `localShellEnvironment.real.extreme.spec.ts --run-real-pty` additionally exercises inherited and nested shell hooks using a real local PTY.

Use `npm run dev` for visual verification of both views, narrow/wide details, font settings, streaming output, reconnection, and restart persistence. Main-process changes require a full application restart. Native Windows ConPTY behavior requires verification on Windows in addition to the platform-independent renderer and protocol regressions.
