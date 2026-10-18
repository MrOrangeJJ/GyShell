/**
 * Pure geometry for the docked prompt: the bottom aperture of the Block view
 * that reveals the real xterm. Nothing here touches the DOM or resizes the
 * PTY; the hook only clips and translates the existing terminal element.
 *
 * There is no separate text field: tab completion, history, Ctrl-C, password
 * prompts and completion menus behave exactly as in the native terminal.
 * Idle shows the prompt only (1-3 rows; a long soft-wrapped input may use
 * more); while a command runs, the dock shows from its start marker down to
 * the cursor, up to ~40% of the height / 12 rows. Content below the cursor
 * (completion menus) is revealed within the cap.
 *
 * The dock is the running command's live tail, not a copy of it: the running
 * block lists its rows only down to the dock's first line, so the stream and
 * the dock read as one block with nothing shown twice.
 */

export const TERMINAL_DOCK_MAX_ROWS = 12;
const TERMINAL_DOCK_MAX_HEIGHT_RATIO = 0.4;
export const TERMINAL_DOCK_IDLE_ROWS = 3;

/** Absolute buffer lines that tell the dock what belongs to the prompt. */
export interface TerminalDockAnchor {
  /** First line of the latest still-running command. */
  runningStartLine?: number;
  /** Line where the latest completed command ended (where the prompt begins). */
  promptStartLine?: number;
}

/** What the Block view needs from the dock, published once per frame. */
export interface TerminalDockState {
  /** Aperture height in px; the Block view reserves this much at the bottom. */
  height: number;
  /** Absolute buffer line of the dock's first row (undefined when hidden). */
  topLine?: number;
}

export const EMPTY_TERMINAL_DOCK_STATE: TerminalDockState = Object.freeze({
  height: 0,
});

/**
 * End (exclusive) of the rows a block lists in the stream. A running block
 * stops where the dock begins: those rows are on screen live in the dock.
 * Settled blocks list everything (the dock then shows the next prompt).
 */
export const resolveListedBlockEnd = (input: {
  outputStart: number;
  end: number;
  running: boolean;
  dockTopLine?: number;
}): number =>
  input.running && input.dockTopLine !== undefined
    ? Math.max(input.outputStart, Math.min(input.end, input.dockTopLine))
    : input.end;

interface DockMarker {
  readonly line: number;
  readonly isDisposed: boolean;
}

interface DockActivity {
  id: string;
  status: string;
}

const liveLine = (marker?: DockMarker): number | undefined =>
  marker && !marker.isDisposed && Number.isFinite(marker.line)
    ? marker.line
    : undefined;

/** Resolves the dock anchor from Activity snapshots and their xterm markers. */
export const resolveTerminalDockAnchor = (
  activities: readonly DockActivity[],
  getRange: (
    activityId: string,
  ) => { start?: DockMarker; end?: DockMarker } | undefined,
): TerminalDockAnchor => {
  let runningStartLine: number | undefined;
  let promptStartLine: number | undefined;
  for (const activity of activities) {
    const range = getRange(activity.id);
    if (activity.status === "running") {
      const start = liveLine(range?.start);
      if (start !== undefined)
        runningStartLine = Math.max(runningStartLine ?? start, start);
    } else {
      const end = liveLine(range?.end);
      if (end !== undefined)
        promptStartLine = Math.max(promptStartLine ?? end, end);
    }
  }
  // A completed command below a "running" one means the running snapshot is
  // stale (for example it lost its end marker); the prompt is what matters.
  if (
    runningStartLine !== undefined &&
    promptStartLine !== undefined &&
    promptStartLine > runningStartLine
  ) {
    runningStartLine = undefined;
  }
  return { runningStartLine, promptStartLine };
};

export const terminalDockMaxRows = (
  availableHeight: number,
  rowHeight: number,
): number => {
  if (!(rowHeight > 0) || !(availableHeight > 0)) return 1;
  const byHeight = Math.floor(
    (availableHeight * TERMINAL_DOCK_MAX_HEIGHT_RATIO) / rowHeight,
  );
  return Math.max(1, Math.min(TERMINAL_DOCK_MAX_ROWS, byHeight));
};

export interface TerminalDockWindowInput {
  /** Viewport row of the cursor. */
  cursorRow: number;
  /** Last viewport row with visible content (e.g. a completion menu below the prompt). */
  contentBottomRow: number;
  /** Viewport row where the cursor's soft-wrapped logical line begins. */
  logicalStartRow: number;
  /** Viewport-relative anchor rows; may be negative when scrolled off. */
  runningStartRow?: number;
  promptStartRow?: number;
  maxRows: number;
}

export interface TerminalDockWindow {
  topRow: number;
  bottomRow: number;
  rows: number;
}

/**
 * Chooses which viewport rows the dock reveals. Idle: the prompt (1–3 rows,
 * more only for a long wrapped input line). Running: everything the running
 * command printed above the cursor, up to maxRows. The cursor is always
 * inside the window, and content below it (completion menus) stays visible.
 */
export const resolveTerminalDockWindow = (
  input: TerminalDockWindowInput,
): TerminalDockWindow => {
  const maxRows = Math.max(1, Math.floor(input.maxRows) || 1);
  const cursorRow = Math.max(0, Math.floor(input.cursorRow) || 0);
  const bottomRow = Math.min(
    Math.max(cursorRow, Math.floor(input.contentBottomRow) || 0),
    cursorRow + maxRows - 1,
  );
  const minTop = bottomRow - maxRows + 1;
  const running =
    input.runningStartRow !== undefined && input.runningStartRow <= cursorRow;
  let topRow: number;
  if (running) {
    topRow = Math.floor(input.runningStartRow!);
  } else {
    const logicalStartRow = Math.min(
      cursorRow,
      Math.floor(input.logicalStartRow),
    );
    const promptStartRow =
      input.promptStartRow !== undefined && input.promptStartRow <= cursorRow
        ? Math.floor(input.promptStartRow)
        : cursorRow;
    const idleTop = cursorRow - TERMINAL_DOCK_IDLE_ROWS + 1;
    // A multi-line prompt is capped at the idle size; a long wrapped input
    // line may exceed it so the start of what the user typed stays visible.
    topRow = Math.min(Math.max(promptStartRow, idleTop), logicalStartRow);
  }
  topRow = Math.min(cursorRow, Math.max(0, minTop, topRow));
  return { topRow, bottomRow, rows: bottomRow - topRow + 1 };
};

export interface TerminalDockGeometry {
  /** Visible aperture height in px. */
  height: number;
  /** clip-path insets on the host. */
  clipTop: number;
  clipBottom: number;
  /** translateY of the terminal mount so `bottomRow` sits at the aperture bottom. */
  offset: number;
}

export const terminalDockGeometry = (
  hostHeight: number,
  rowHeight: number,
  window: TerminalDockWindow,
  bottomInset = 0,
): TerminalDockGeometry => {
  const inset = Math.max(0, bottomInset);
  const available = Math.max(0, hostHeight - inset);
  const height = Math.max(0, Math.min(available, window.rows * rowHeight));
  return {
    height,
    clipTop: Math.max(0, available - height),
    clipBottom: inset,
    // Negative when the window's bottom row would otherwise sit under the
    // footer inset; the terminal is shifted up instead of hiding the cursor.
    offset: available - (window.bottomRow + 1) * rowHeight,
  };
};
