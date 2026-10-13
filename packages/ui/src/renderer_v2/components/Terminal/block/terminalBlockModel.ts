import type { IBuffer, IBufferCell, IBufferLine } from "@xterm/xterm";
import type { TerminalActivitySnapshot } from "@gyshell/shared";

/**
 * Block projection of the terminal buffer. The xterm stays the only PTY
 * renderer and stream consumer
 * (PTY -> TerminalWriteCoordinator -> xterm -> Block projection): blocks are
 * read from the retained normal buffer and Activity markers. Nothing here
 * parses commands independently, injects separators or runs a second
 * terminal. Pure: works on any IBuffer (also @xterm/headless in specs).
 */

export interface BlockBoundary {
  id: string;
  startLine: number;
  endLine?: number;
}

/** One command's buffer span with its Activity; shared by both views. */
export interface TerminalCommandAnnotation extends BlockBoundary {
  activity: TerminalActivitySnapshot;
  /** Command read from the prompt line when the Activity has none. */
  bufferPreview?: string;
  /** Output ended mid-row; the next prompt continues on that same row. */
  endSharesNextRow?: boolean;
}

export interface BlockSpan {
  id: string;
  startLine: number;
  endLine: number;
  boundaryId?: string;
}

export interface BlockColor {
  mode: "default" | "palette" | "rgb";
  value: number;
}

export interface BlockCellFragment {
  chars: string;
  columns: number;
}

export interface BlockRun {
  text: string;
  columns: number;
  cells: BlockCellFragment[];
  foreground: BlockColor;
  background: BlockColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  inverse: boolean;
  invisible: boolean;
  underline: boolean;
  overline: boolean;
  strikethrough: boolean;
  blink: boolean;
}

export interface BlockRow {
  line: number;
  wrapped: boolean;
  text: string;
  runs: BlockRun[];
}

export const readTerminalBlockLogicalLine = (
  buffer: IBuffer,
  startLine: number,
  endLine: number,
  cols: number,
): { endLine: number; text: string } | undefined => {
  let text = "";
  let line = startLine;
  do {
    const current = buffer.getLine(line);
    if (!current) return undefined;
    const nextWrapped =
      line + 1 < endLine && buffer.getLine(line + 1)?.isWrapped;
    let endColumn = Math.min(cols, current.length);
    // A wide glyph may wrap before the last column. Ignore only null padding,
    // never an actual space character written by the application.
    while (nextWrapped && endColumn > 0) {
      const cell = current.getCell(endColumn - 1);
      if (!cell || cell.getWidth() === 0 || cell.getChars()) break;
      endColumn -= 1;
    }
    text += current.translateToString(!nextWrapped, 0, endColumn);
    line += 1;
    if (!nextWrapped) break;
  } while (line < endLine && text.length <= 8192);
  return { endLine: line, text };
};

/**
 * The command typed after a shell prompt ("host:~ me$ ls -la" -> "ls -la").
 * Uses the first prompt delimiter followed by whitespace ($ # % > ❯ ›), so a
 * ">" inside the command itself is kept. Undefined when no prompt is found.
 */
export const commandFromPromptLine = (
  text: string | undefined,
): string | undefined => {
  const line = text?.trim();
  if (!line) return undefined;
  const match = line.match(/[$#>%\u276f\u203a]\s+(\S.*)$/);
  const command = match?.[1]?.trim();
  return command && command.length <= 300 ? command : undefined;
};

/** Only fold an exact, single logical command echo; uncertain cells stay visible. */
export const findTerminalCommandEcho = (
  buffer: IBuffer,
  startLine: number,
  endLine: number,
  command: string | undefined,
  cols = buffer.getLine(startLine)?.length || 0,
): { endLine: number; text: string } | undefined => {
  if (!command || /[\r\n\t]/.test(command)) return undefined;
  const echo = readTerminalBlockLogicalLine(buffer, startLine, endLine, cols);
  return echo?.text.endsWith(command) ? echo : undefined;
};

const toCount = (value: number): number =>
  Number.isFinite(value)
    ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)))
    : 0;

/** Keep tail previews bounded without starting in the middle of a soft wrap. */
export const getTerminalBlockPreviewStart = (
  buffer: IBuffer,
  startLine: number,
  endLine: number,
  maxRows: number,
): number => {
  const end = Math.min(toCount(endLine), buffer.length);
  const start = Math.min(toCount(startLine), end);
  let preview = Math.max(start, end - toCount(maxRows));
  if (preview === start) return start;
  while (preview < end && buffer.getLine(preview)?.isWrapped) preview += 1;
  return preview;
};

/** Partitions the buffer once; command metadata never owns duplicate rows. */
export const buildTerminalBlockSpans = (
  lineCount: number,
  boundaries: readonly BlockBoundary[],
): BlockSpan[] => {
  const count = toCount(lineCount);
  if (count === 0) return [];

  const ordered = boundaries
    .map((boundary, order) => ({
      ...boundary,
      startLine: Math.floor(boundary.startLine),
      order,
    }))
    .filter(
      (boundary) =>
        Number.isFinite(boundary.startLine) &&
        boundary.startLine >= 0 &&
        boundary.startLine < count,
    )
    .sort(
      (left, right) =>
        left.startLine - right.startLine || left.order - right.order,
    );

  // Multiple commands can share a rewritten prompt row. The latest boundary
  // annotates that row; showing each one would duplicate the terminal output.
  const unique: typeof ordered = [];
  for (const boundary of ordered) {
    if (unique.at(-1)?.startLine === boundary.startLine) {
      unique[unique.length - 1] = boundary;
    } else {
      unique.push(boundary);
    }
  }

  const blocks: BlockSpan[] = [];
  let cursor = 0;
  const appendUnattributed = (endLine: number): void => {
    if (endLine <= cursor) return;
    blocks.push({
      id: `buffer:${cursor}`,
      startLine: cursor,
      endLine,
    });
    cursor = endLine;
  };

  unique.forEach((boundary, index) => {
    appendUnattributed(boundary.startLine);
    const nextStartLine = unique[index + 1]?.startLine ?? count;
    const endLine = Math.min(
      nextStartLine,
      Number.isFinite(boundary.endLine)
        ? Math.max(boundary.startLine + 1, Math.floor(boundary.endLine!))
        : nextStartLine,
    );
    blocks.push({
      id: `command:${boundary.id}:${boundary.startLine}`,
      startLine: boundary.startLine,
      endLine,
      boundaryId: boundary.id,
    });
    cursor = endLine;
  });
  appendUnattributed(count);
  return blocks;
};

const readColor = (cell: IBufferCell, foreground: boolean): BlockColor => {
  const rgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  const palette = foreground ? cell.isFgPalette() : cell.isBgPalette();
  return {
    mode: rgb ? "rgb" : palette ? "palette" : "default",
    value:
      rgb || palette ? (foreground ? cell.getFgColor() : cell.getBgColor()) : 0,
  };
};

const sameRunStyle = (left: BlockRun, right: BlockRun): boolean =>
  left.foreground.mode === right.foreground.mode &&
  left.foreground.value === right.foreground.value &&
  left.background.mode === right.background.mode &&
  left.background.value === right.background.value &&
  left.bold === right.bold &&
  left.dim === right.dim &&
  left.italic === right.italic &&
  left.inverse === right.inverse &&
  left.invisible === right.invisible &&
  left.underline === right.underline &&
  left.overline === right.overline &&
  left.strikethrough === right.strikethrough &&
  left.blink === right.blink;

/** Copies parsed cells, including their display width, without retaining xterm references. */
export const readTerminalBlockRow = (
  buffer: IBuffer,
  lineIndex: number,
  cols: number,
): BlockRow => {
  const row: BlockRow = {
    line: lineIndex,
    wrapped: false,
    text: "",
    runs: [],
  };
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return row;
  const line = buffer.getLine(lineIndex);
  if (!line) return row;
  row.wrapped = line.isWrapped;
  const columnCount = Math.min(toCount(cols), line.length);
  const reusableCell = buffer.getNullCell();

  for (let column = 0; column < columnCount; column += 1) {
    const cell = line.getCell(column, reusableCell);
    if (!cell || cell.getWidth() === 0) continue;
    const fragment: BlockCellFragment = {
      chars: cell.getChars() || " ",
      columns: Math.min(cell.getWidth(), columnCount - column),
    };
    const run: BlockRun = {
      text: fragment.chars,
      columns: fragment.columns,
      cells: [fragment],
      foreground: readColor(cell, true),
      background: readColor(cell, false),
      bold: Boolean(cell.isBold()),
      dim: Boolean(cell.isDim()),
      italic: Boolean(cell.isItalic()),
      inverse: Boolean(cell.isInverse()),
      invisible: Boolean(cell.isInvisible()),
      underline: Boolean(cell.isUnderline()),
      overline: Boolean(cell.isOverline()),
      strikethrough: Boolean(cell.isStrikethrough()),
      blink: Boolean(cell.isBlink()),
    };
    row.text += run.text;
    const previous = row.runs.at(-1);
    if (previous && sameRunStyle(previous, run)) {
      previous.text += run.text;
      previous.columns += run.columns;
      previous.cells.push(fragment);
    } else {
      row.runs.push(run);
    }
  }
  return row;
};

/** Copies a physical row range while retaining whitespace across soft wraps. */
export const copyTerminalBlockRange = (
  buffer: IBuffer,
  startLine: number,
  endLine: number,
  cols: number,
): string => {
  const start = Math.min(toCount(startLine), buffer.length);
  const end = Math.min(toCount(endLine), buffer.length);
  if (start >= end || toCount(cols) === 0) return "";
  const parts: string[] = [];
  for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
    const row = readTerminalBlockRow(buffer, lineIndex, cols);
    const continues = buffer.getLine(lineIndex + 1)?.isWrapped === true;
    parts.push(continues ? row.text : row.text.trimEnd());
    if (!continues && lineIndex + 1 < end) parts.push("\n");
  }
  return parts.join("");
};

const hasVisibleContent = (
  line: IBufferLine,
  cols: number,
  reusableCell: IBufferCell,
): boolean => {
  if (line.isWrapped) return true;
  const columnCount = Math.min(cols, line.length);
  for (let column = 0; column < columnCount; column += 1) {
    const cell = line.getCell(column, reusableCell);
    if (!cell) continue;
    if (
      cell.getChars().trim().length > 0 ||
      !cell.isBgDefault() ||
      cell.isInverse() ||
      cell.isUnderline() ||
      cell.isOverline() ||
      cell.isStrikethrough()
    ) {
      return true;
    }
  }
  return false;
};

/** Removes only unused screen-tail rows, never scrollback or rows below a moved cursor. */
export const getTerminalBlockLineCount = (
  buffer: IBuffer,
  cols: number,
): number => {
  const length = toCount(buffer.length);
  if (length === 0) return 0;
  const columnCount = toCount(cols);
  if (columnCount === 0) return length;
  const minimum = Math.min(
    length,
    Math.max(toCount(buffer.baseY), toCount(buffer.baseY + buffer.cursorY) + 1),
  );
  const reusableCell = buffer.getNullCell();
  let count = length;
  while (count > minimum) {
    const line = buffer.getLine(count - 1);
    if (line && hasVisibleContent(line, columnCount, reusableCell)) break;
    count -= 1;
  }
  return count;
};

/**
 * Last row (exclusive) of a Block. A Block normally stops where the next one
 * starts. When the command's output did not end with a newline, the next
 * prompt continues on the output's last row, so that shared row still belongs
 * to this Block instead of being dropped as "no output".
 */
export const resolveTerminalBlockEnd = (input: {
  startLine: number;
  endLine?: number;
  endSharesNextRow?: boolean;
  nextStartLine: number;
  lineCount: number;
}): number => {
  const cap = input.endSharesNextRow
    ? input.nextStartLine + 1
    : input.nextStartLine;
  const end = Math.min(input.endLine ?? cap, cap, input.lineCount);
  return Math.max(input.startLine, end);
};
