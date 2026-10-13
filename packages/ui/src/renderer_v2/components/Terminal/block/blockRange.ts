import type { Terminal } from "@xterm/xterm";
import {
  commandFromPromptLine,
  copyTerminalBlockRange,
  findTerminalCommandEcho,
  readTerminalBlockLogicalLine,
  resolveTerminalBlockEnd,
  type TerminalCommandAnnotation,
} from "./terminalBlockModel";

/** Buffer rows owned by one block, with the command echo separated from output. */
export interface BlockRange {
  outputStart: number;
  end: number;
}

/** Logical rows a prompt line may span when reading a command from it. */
const PROMPT_LINE_MAX_ROWS = 4;

export const resolveBlockRange = (
  terminal: Terminal,
  annotation: TerminalCommandAnnotation,
  nextStartLine: number,
  lineCount: number,
): BlockRange => {
  const buffer = terminal.buffer.normal;
  let end = resolveTerminalBlockEnd({
    startLine: annotation.startLine,
    endLine: annotation.endLine,
    endSharesNextRow: annotation.endSharesNextRow,
    nextStartLine,
    lineCount,
  });
  const start = Math.min(annotation.startLine, end);
  // Fold only the echo line we can attribute: an exact command echo, or the
  // prompt line the header's command was read from when none was recorded.
  const echo = annotation.activity.command
    ? findTerminalCommandEcho(
        buffer,
        start,
        end,
        annotation.activity.command,
        terminal.cols,
      )
    : readTerminalBlockLogicalLine(buffer, start, end, terminal.cols);
  const outputStart = Math.min(echo?.endLine ?? start, end);
  // Trailing blank rows are padding, not output.
  while (
    end > outputStart &&
    !buffer
      .getLine(end - 1)
      ?.translateToString(true)
      .trim()
  ) {
    end -= 1;
  }
  return { outputStart, end };
};

/**
 * The command as run: the Activity's own record, else the command typed after
 * the prompt on the block's first logical line (manual shell input).
 */
export const resolveBlockCommand = (
  terminal: Terminal,
  annotation: TerminalCommandAnnotation,
): string | undefined => {
  const recorded = annotation.activity.command?.trim();
  if (recorded) return recorded;
  const buffer = terminal.buffer.normal;
  const promptLine = readTerminalBlockLogicalLine(
    buffer,
    annotation.startLine,
    Math.min(
      annotation.startLine + PROMPT_LINE_MAX_ROWS,
      annotation.endLine ?? buffer.length,
    ),
    terminal.cols,
  );
  return commandFromPromptLine(promptLine?.text);
};

/** The command's output rows only; the prompt/command echo is not output. */
export const getBlockOutputText = (
  terminal: Terminal,
  range: BlockRange,
): string =>
  range.end > range.outputStart
    ? copyTerminalBlockRange(
        terminal.buffer.normal,
        range.outputStart,
        range.end,
        terminal.cols,
      )
    : "";

/** Output lines as printed: soft-wrapped rows count once, so the number does
 *  not change with the panel width. */
export const countBlockOutputLines = (
  terminal: Terminal,
  range: BlockRange,
): number => {
  const buffer = terminal.buffer.normal;
  let lines = 0;
  for (let row = range.outputStart; row < range.end; row += 1) {
    if (row === range.outputStart || !buffer.getLine(row)?.isWrapped)
      lines += 1;
  }
  return lines;
};
