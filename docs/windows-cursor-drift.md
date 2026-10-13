# Windows terminal cursor drift ("cursor jumps back into old output")

## Symptom

In a local Windows PowerShell tab the cursor (where the terminal will write
next) sometimes jumps up into rows that are already filled. After that, Enter
or command output overwrites old content. The "Session Resumed" divider can
end up on top of prompt lines. Resizing the panel puts everything right again.

## Root cause

Windows pseudoconsoles (ConPTY, and winpty in the same way) do not just
stream text. They keep their own screen and redraw parts of it with
**absolute cursor moves** (`ESC[row;colH`). Those row numbers count from the
top of **ConPTY's own viewport**. This happens when PSReadLine redraws the
input line, when blank rows are skipped, or for progress output and menus.

The xterm renderer GyShell shows is not a copy of that screen. Its viewport
has rows ConPTY never produced, and it lacks rows ConPTY did produce:

| Where the screens diverge | Code | Effect on renderer vs. ConPTY rows |
|---|---|---|
| Startup bytes before the readiness marker, including ConPTY's own clear, are dropped (`Clear-Host` in `windowsPowerShellTracking.ts`; pre-ready buffering in `NodePtyBackend`) | renderer is not cleared | ConPTY is at row 1 while the renderer is below old content |
| Restored durable history plus the session spacing (`restoreTerminalPersistence`) | renderer only | renderer is N rows lower |
| Banner written on a 500 ms timer (`printBanner`) | renderer only | renderer is 7 rows lower |
| Agent commands run through the PowerShell sidecar (`synthetic-transcript`): the raw dispatch echo is hidden and a synthetic transcript is written instead | rows differ both ways | either direction |
| Local reconnect: a new ConPTY under the old renderer screen | renderer only | renderer is lower |

Plain text and line breaks are relative moves, so everything looks right at
first. The first absolute move from ConPTY then puts the renderer cursor
`N` rows too high, and later output overwrites existing rows. That is the
"after a while". The drift repeats until ConPTY's cursor reaches the bottom
row. A resize "fixes" it only because ConPTY then redraws its whole viewport.

### Evidence

- `packages/backend/src/services/terminal/pseudoconsoleViewport.extreme.spec.ts`
  feeds a headless xterm the same kind of byte stream the renderer gets. Each
  case first **reproduces** the bug:
  - restored history and the banner are overwritten by `PS C:\> dir` /
    `Directory: …`;
  - after an agent transcript, typed `ls` lands on the transcript line
    (`commit 0ls`).
- Control runs during the investigation:
  - The same stream with no renderer-only rows renders correctly.
  - Renderer rows ≠ PTY rows with no injected lines also renders correctly.
  - So a size mismatch is **not** the cause.
- `terminalPersistence.extreme.spec.ts`, case *"Windows ConPTY runtime is
  realigned below restored history and synthetic rows"*, runs the real
  `TerminalService` restore → ready → ConPTY output → synthetic transcript →
  input path. With the fix disabled (the helpers made to return `''`), it fails:
  - restored rows are overwritten: the first row becomes `PS C:\> dir`;
  - after the transcript the renderer row is 7 while the ConPTY row is 4.

## Previous fix attempts (git history)

| Commit | Hypothesis | Change | Why it did not fix this |
|---|---|---|---|
| `56c0709` (2026-03-16) *win shell bug fix* | The renderer lacked Windows PTY semantics | xterm `windowsPty` option, recovery refit | Only changes how lines wrap and reflow; no effect on cursor rows |
| `c68150e` (2026-04-07) *win ps render fix* | One extra line from the prompt function caused it | Removed `Write-Host __GYSHELL_TASK_FINISH__` from the prompt | Removed one source of extra rows; restored history, banner, transcripts and reconnects remain |
| `41b4d1e` / `a3f80d1` (2026-07-12) *harden Windows terminal cursor synchronization* | Resize racing with writes, or a wrong build number | Ordering between writes and refit; build info sent with output; build 18309 by default | Fixes a real race, but the drift happens without any size mismatch |
| `cafb604` / `b83127b` (2026-10) winpty readiness | Readiness detection | Ready marker printed as a line on winpty | Readiness only; startup bytes are still dropped |

None of these touched the renderer-only rows or the startup hand-off.

## Fix

The renderer is kept on ConPTY's row grid. No content is erased; rows are
moved into scrollback instead:

1. **New runtime hand-off.** Runs when a local pseudoconsole shell becomes
   ready, and after the banner. Code: `TerminalService.alignRendererWithPseudoconsole`
   and `buildPseudoconsoleViewportHandoff`.
   - Every used renderer row is scrolled into scrollback and the cursor is
     moved home. The renderer then matches ConPTY's freshly cleared screen,
     while restored history and the divider stay intact above it.
   - Then a ConPTY repaint is requested (`NodePtyBackend.requestRepaint`), so
     ConPTY restates its exact screen. This does the same thing a manual
     resize did.
2. **Continuous realignment.**
   - A small headless "shadow" screen is fed only ConPTY's raw bytes, so it
     knows where ConPTY's cursor is. Code: `pseudoconsoleShadowByTerminal`.
   - When output goes quiet (80 ms) after renderer-only rows or new PTY
     output, the renderer mirror's cursor row is compared with the shadow's.
   - If they differ, display-only bytes are written that move the renderer
     cursor onto ConPTY's row. Code: `buildPseudoconsoleRowRealignment`.
   - If the renderer is too low, older rows scroll into scrollback. If it is
     too high, blank rows are inserted at the top.
3. **Divider spacing.** Two line breaks are always written at a session
   boundary, so the divider row never shares a row with the first new prompt.
   Before this change, the spacing was a single line break whenever the
   restored text ended in `\n`.

This applies only to local runtimes whose backend reports
`usesPseudoconsoleViewport()` (Windows). macOS and Linux paths are unchanged.

## Other "Session Resumed" placement fixes (item 2c)

- **Clear-screen.** `cls`/`clear` (ED2) erased the rows under the divider,
  and later output was then drawn on the divider row. The renderer now uses
  `scrollOnEraseInDisplay`, the same behavior as Windows Terminal, iTerm and
  Terminal.app: cleared rows move into scrollback with their divider. ED3
  (clear scrollback) still removes both.
- **The divider never hides content.** It is only drawn while its reserved
  row is blank (`terminalSessionDividerPlacement.ts`). After an unexpected
  full redraw it disappears instead of covering text.
- **Fallback divider anchor.** Boundaries restored through `offsetAnchors`
  pointed at the restored prompt row instead of the spacing row below it.
  They are now shifted by one row, as `registerRestoreMarker(1)` does.
- **Split SSH bootstrap clear.** A restored SSH tab dropped the reconnect clear
  only if it arrived as one chunk. A clear split across chunks erased the
  restored rows. Partial prefixes are now held until they are confirmed.
