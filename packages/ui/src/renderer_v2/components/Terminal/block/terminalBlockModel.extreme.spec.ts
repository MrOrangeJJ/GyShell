import assert from "node:assert/strict";
import pkg from "@xterm/headless";
import {
  buildTerminalBlockSpans,
  copyTerminalBlockRange,
  getTerminalBlockLineCount,
  getTerminalBlockPreviewStart,
  findTerminalCommandEcho,
  readTerminalBlockRow,
  resolveTerminalBlockEnd,
  type BlockBoundary,
} from "./terminalBlockModel";

const { Terminal } = pkg;
type TestTerminal = InstanceType<typeof Terminal>;

const createTerminal = (cols = 24, rows = 8): TestTerminal =>
  new Terminal({ cols, rows, scrollback: 40, allowProposedApi: true });

const write = (terminal: TestTerminal, data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve));

const row = (terminal: TestTerminal, line = 0) =>
  readTerminalBlockRow(terminal.buffer.active, line, terminal.cols);

const lineCount = (terminal: TestTerminal): number =>
  getTerminalBlockLineCount(terminal.buffer.active, terminal.cols);

const assertCoverage = (count: number, boundaries: BlockBoundary[]): void => {
  const blocks = buildTerminalBlockSpans(count, boundaries);
  let cursor = 0;
  const ids = new Set<string>();
  for (const block of blocks) {
    assert.equal(
      block.startLine,
      cursor,
      "there must be no gaps or duplicate rows",
    );
    assert.ok(
      block.endLine > block.startLine,
      "empty blocks must not be rendered",
    );
    assert.ok(block.endLine <= count);
    assert.ok(!ids.has(block.id), "block keys must remain unique");
    ids.add(block.id);
    cursor = block.endLine;
  }
  assert.equal(cursor, count);
};

const run = async (): Promise<void> => {
  {
    const terminal = createTerminal(10, 12);
    await write(terminal, "first\r\nabcdefghijklmnopqrstuvw\r\nlast");
    const buffer = terminal.buffer.normal;
    assert.equal(lineCount(terminal), 5);
    assert.equal(getTerminalBlockPreviewStart(buffer, 0, 5, 3), 4);
    assert.equal(getTerminalBlockPreviewStart(buffer, 0, 5, 4), 1);
    assert.equal(getTerminalBlockPreviewStart(buffer, 0, 5, 5), 0);
    assert.equal(getTerminalBlockPreviewStart(buffer, 0, 5, 0), 5);
    assert.equal(
      getTerminalBlockPreviewStart(buffer, 1, 4, 2),
      4,
      "a logical line exceeding the preview budget stays fully folded",
    );
    assert.equal(
      getTerminalBlockPreviewStart(buffer, 2, 4, 2),
      2,
      "a retained block boundary must not discard available leading cells",
    );
    terminal.resize(5, 12);
    const preview = getTerminalBlockPreviewStart(buffer, 0, lineCount(terminal), 3);
    assert.equal(buffer.getLine(preview)?.isWrapped, false);
    assert.equal(buffer.getLine(preview)?.translateToString(true), "last");
    terminal.dispose();
    console.log("PASS bounded tail previews retain complete logical lines across reflow");
  }
  {
    const terminal = createTerminal(18, 12);
    const command = "printf 'long command with Unicode: \u4f60\u597d'";
    await write(terminal, `$ ${command}\r\nactual output\r\n`);
    const echo = findTerminalCommandEcho(
      terminal.buffer.normal,
      0,
      lineCount(terminal),
      command,
    );
    assert.ok(echo && echo.endLine > 1);
    assert.equal(echo.text, `$ ${command}`);
    assert.equal(row(terminal, echo.endLine).text.trimEnd(), "actual output");
    assert.equal(
      findTerminalCommandEcho(
        terminal.buffer.normal,
        0,
        lineCount(terminal),
        "different command",
      ),
      undefined,
    );
    assert.equal(
      findTerminalCommandEcho(
        terminal.buffer.normal,
        0,
        lineCount(terminal),
        "printf x\nprintf y",
      ),
      undefined,
    );
    assert.equal(
      findTerminalCommandEcho(
        terminal.buffer.normal,
        0,
        lineCount(terminal),
        undefined,
      ),
      undefined,
    );
    terminal.resize(40, 12);
    const reflowed = findTerminalCommandEcho(
      terminal.buffer.normal,
      0,
      lineCount(terminal),
      command,
    );
    assert.equal(reflowed?.text, `$ ${command}`);
    terminal.dispose();
    console.log(
      "PASS exact command echo recognition, Unicode reflow and uncertain-byte fallback",
    );
  }
  assert.deepEqual(buildTerminalBlockSpans(0, []), []);
  assert.deepEqual(buildTerminalBlockSpans(4, []), [
    { id: "buffer:0", startLine: 0, endLine: 4 },
  ]);
  assert.deepEqual(
    buildTerminalBlockSpans(10, [
      { id: "a", startLine: 2, endLine: 5 },
      { id: "b", startLine: 7, endLine: 8 },
    ]).map(({ startLine, endLine, boundaryId }) => [
      startLine,
      endLine,
      boundaryId,
    ]),
    [
      [0, 2, undefined],
      [2, 5, "a"],
      [5, 7, undefined],
      [7, 8, "b"],
      [8, 10, undefined],
    ],
  );
  assert.deepEqual(
    buildTerminalBlockSpans(8, [
      { id: "earlier", startLine: 2, endLine: 7 },
      { id: "later", startLine: 2, endLine: 5 },
      { id: "next", startLine: 4, endLine: 6 },
    ]).map(({ startLine, endLine, boundaryId }) => [
      startLine,
      endLine,
      boundaryId,
    ]),
    [
      [0, 2, undefined],
      [2, 4, "later"],
      [4, 6, "next"],
      [6, 8, undefined],
    ],
  );
  assertCoverage(8, [
    { id: "invalid", startLine: -1 },
    { id: "invalid", startLine: Number.NaN },
    { id: "invalid", startLine: Number.POSITIVE_INFINITY },
    { id: "beyond", startLine: 8 },
    { id: "same-id", startLine: 1, endLine: 0 },
    { id: "same-id", startLine: 5, endLine: 20 },
  ]);
  let seed = 42;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const count = next() % 100;
    const boundaries = Array.from({ length: next() % 30 }, (_, index) => ({
      id: String(index % 3),
      startLine: (next() % 120) - 10,
      ...(next() % 2 === 0 ? { endLine: (next() % 120) - 10 } : {}),
    }));
    assertCoverage(count, boundaries);
  }
  console.log(
    "PASS boundary-free, overlapping, repeated, and malformed metadata preserve every row exactly once",
  );

  {
    const terminal = createTerminal();
    assert.equal(lineCount(terminal), 1, "the cursor row must remain visible");
    await write(terminal, "old-long\rnew\x1b[K");
    assert.equal(
      row(terminal).text.trimEnd(),
      "new",
      "CR and erase must be resolved by xterm",
    );
    await write(terminal, "\r\nsecond\x1b[1A\r\x1b[2Kupdated");
    assert.equal(row(terminal).text.trimEnd(), "updated");
    assert.equal(row(terminal, 1).text.trimEnd(), "second");
    assert.equal(
      lineCount(terminal),
      2,
      "moving the cursor upward must not discard lower output",
    );
    await write(terminal, "\x1b[8;1Htail\x1b[H");
    assert.equal(
      lineCount(terminal),
      8,
      "absolute cursor movement must not hide populated rows",
    );
    await write(terminal, "\x1b[2J\x1b[H");
    assert.equal(
      lineCount(terminal),
      1,
      "cleared default screen-tail rows may be removed",
    );
    terminal.dispose();
    console.log(
      "PASS CR, erasure, cursor-up, cursor addressing, and cleared screen-tail behavior",
    );
  }

  {
    const terminal = createTerminal(12, 6);
    await write(terminal, "\x1b[42m\x1b[6;1H\x1b[2K\x1b[0m\x1b[H");
    assert.equal(
      lineCount(terminal),
      6,
      "background-only rows are visible terminal output",
    );
    assert.deepEqual(row(terminal, 5).runs[0].background, {
      mode: "palette",
      value: 2,
    });
    await write(terminal, "\x1b[2J\x1b[H\x1b[6;1H\x1b[7m \x1b[0m\x1b[H");
    assert.equal(
      lineCount(terminal),
      6,
      "inverse blank cells have visible backgrounds",
    );
    await write(terminal, "\x1b[2J\x1b[H\x1b[6;1H\x1b[4m \x1b[0m\x1b[H");
    assert.equal(
      lineCount(terminal),
      6,
      "decorated blank cells must not disappear",
    );
    terminal.dispose();
    console.log(
      "PASS background, inverse, and decorated whitespace remain visible",
    );
  }

  {
    const terminal = createTerminal(12, 4);
    await write(terminal, "\x1b[31mAB\x1b[38;5;196;48;2;12;34;56mC\x1b[0mD");
    const snapshot = row(terminal);
    assert.equal(snapshot.runs[0].text, "AB");
    assert.equal(snapshot.runs[0].columns, 2);
    assert.deepEqual(snapshot.runs[0].cells, [
      { chars: "A", columns: 1 },
      { chars: "B", columns: 1 },
    ]);
    assert.deepEqual(snapshot.runs[0].foreground, {
      mode: "palette",
      value: 1,
    });
    assert.deepEqual(snapshot.runs[1].foreground, {
      mode: "palette",
      value: 196,
    });
    assert.deepEqual(snapshot.runs[1].background, {
      mode: "rgb",
      value: 0x0c2238,
    });
    assert.deepEqual(snapshot.runs[2].foreground, {
      mode: "default",
      value: 0,
    });
    assert.equal(
      snapshot.runs.reduce((sum, run) => sum + run.columns, 0),
      12,
    );
    await write(terminal, "\r\x1b[2K\x1b[1;2;3;4;5;7;8;9;53mX\x1b[0m");
    const styled = row(terminal).runs[0];
    for (const key of [
      "bold",
      "dim",
      "italic",
      "underline",
      "blink",
      "inverse",
      "invisible",
      "strikethrough",
      "overline",
    ] as const) {
      assert.equal(
        styled[key],
        true,
        `the ${key} attribute must survive projection`,
      );
    }
    assert.equal(
      snapshot.runs[0].text,
      "AB",
      "snapshots must not retain mutable parser cell references",
    );
    assert.equal(snapshot.runs[0].cells[0].chars, "A");
    terminal.dispose();
    console.log(
      "PASS ANSI palette/RGB/default colors, complete style flags, run coalescing, and immutable snapshots",
    );
  }

  {
    const terminal = createTerminal(12, 4);
    await write(terminal, "\x1b[31m界\x1b[0me\u0301😀");
    const snapshot = row(terminal);
    assert.equal(snapshot.runs[0].text, "界");
    assert.equal(snapshot.runs[0].columns, 2);
    assert.deepEqual(snapshot.runs[0].cells, [{ chars: "界", columns: 2 }]);
    assert.deepEqual(snapshot.runs[1].cells.slice(0, 2), [
      { chars: "e\u0301", columns: 1 },
      { chars: "😀", columns: 1 },
    ]);
    for (const run of snapshot.runs) {
      assert.equal(
        run.cells.reduce((sum, cell) => sum + cell.columns, 0),
        run.columns,
      );
      assert.equal(run.cells.map((cell) => cell.chars).join(""), run.text);
    }
    assert.equal(snapshot.text.trimEnd(), "界e\u0301😀");
    assert.equal(
      snapshot.runs.reduce((sum, run) => sum + run.columns, 0),
      terminal.cols,
    );
    assert.equal(
      snapshot.text,
      "界e\u0301😀" +
        " ".repeat(terminal.cols - terminal.buffer.active.cursorX),
    );
    assert.equal(
      readTerminalBlockRow(terminal.buffer.active, 0, 2).runs[0].columns,
      2,
    );
    assert.equal(
      readTerminalBlockRow(terminal.buffer.active, 0, 1).runs[0].columns,
      1,
    );
    assert.deepEqual(
      readTerminalBlockRow(terminal.buffer.active, -1, 12).runs,
      [],
    );
    assert.deepEqual(
      readTerminalBlockRow(terminal.buffer.active, 20, 12).runs,
      [],
    );
    terminal.dispose();
    console.log(
      "PASS wide/combining/emoji cells follow parser widths, with blank-cell padding and safe clipping",
    );
  }

  {
    const terminal = createTerminal(7, 6);
    await write(terminal, "foo    bar\r\nnext  \r\n\r\nend");
    assert.equal(
      copyTerminalBlockRange(terminal.buffer.active, 0, 2, terminal.cols),
      "foo    bar",
      "spaces preceding a soft wrap must not disappear",
    );
    assert.equal(
      copyTerminalBlockRange(terminal.buffer.active, 0, 1, terminal.cols),
      "foo    ",
      "a range ending inside a logical line must retain its actual cells",
    );
    assert.equal(
      copyTerminalBlockRange(terminal.buffer.active, 1, 2, terminal.cols),
      "bar",
      "a range starting inside a logical line must not gain a newline",
    );
    assert.equal(
      copyTerminalBlockRange(terminal.buffer.active, 0, 5, terminal.cols),
      "foo    bar\nnext\n\nend",
      "hard line breaks and blank logical lines must survive copying",
    );
    assert.equal(copyTerminalBlockRange(terminal.buffer.active, 3, 2, 7), "");
    assert.equal(copyTerminalBlockRange(terminal.buffer.active, 0, 5, 0), "");
    assert.equal(
      copyTerminalBlockRange(terminal.buffer.active, 0, 100, terminal.cols),
      "foo    bar\nnext\n\nend\n",
      "the range must be bounded by the retained buffer",
    );
    terminal.dispose();
    console.log(
      "PASS range copying preserves soft-wrap whitespace, hard newlines, empty lines, and partial ranges",
    );
  }

  {
    const terminal = createTerminal(10, 5);
    await write(terminal, "abcdefghijABCDEFGHIJ\r\n$ ");
    assert.equal(row(terminal, 1).wrapped, true);
    terminal.resize(5, 5);
    assert.equal(lineCount(terminal), 5);
    assert.equal(
      Array.from({ length: 4 }, (_, index) => row(terminal, index).text).join(
        "",
      ),
      "abcdefghijABCDEFGHIJ",
    );
    assert.equal(row(terminal, 3).wrapped, true);
    terminal.dispose();

    const windowsTerminal = new Terminal({
      cols: 10,
      rows: 5,
      allowProposedApi: true,
      windowsPty: { backend: "conpty", buildNumber: 18309 },
    });
    await write(windowsTerminal, "abcdefghijABCDEFGHIJ");
    windowsTerminal.resize(5, 5);
    assert.ok(
      windowsTerminal.buffer.active.getLine(0)!.length > windowsTerminal.cols,
    );
    assert.equal(
      row(windowsTerminal).text,
      "abcde",
      "projection must respect actual visible columns on Windows",
    );
    windowsTerminal.dispose();
    console.log(
      "PASS normal reflow, wrapped rows, and pre-reflow ConPTY column bounds",
    );
  }

  {
    const terminal = createTerminal(16, 5);
    await write(terminal, "shell output\r\n$ ");
    await write(terminal, "\x1b[?1049h\x1b[2J\x1b[HTUI");
    assert.equal(terminal.buffer.active.type, "alternate");
    assert.equal(row(terminal).text.trimEnd(), "TUI");
    assert.equal(
      readTerminalBlockRow(
        terminal.buffer.normal,
        0,
        terminal.cols,
      ).text.trimEnd(),
      "shell output",
    );
    await write(terminal, "\x1b[?1049l");
    assert.equal(terminal.buffer.active.type, "normal");
    assert.equal(row(terminal).text.trimEnd(), "shell output");
    await write(terminal, "\r\n".repeat(12));
    const savedBase = terminal.buffer.active.baseY;
    await write(terminal, "\x1b[H");
    assert.ok(savedBase > 0);
    assert.equal(
      lineCount(terminal),
      savedBase + 1,
      "blank scrollback must never be trimmed as unused screen space",
    );
    assertCoverage(lineCount(terminal), []);
    terminal.dispose();
    console.log(
      "PASS alternate/normal buffer independence and complete unannotated scrollback coverage",
    );
  }

  {
    // Rows: 0 "$ echo hi", 1 "hi", 2 "$ printf x", 3 "x$ echo y", 4 "y", 5 "$ ".
    // Newline-terminated output: the end row is the next prompt's row and
    // must not be shown as output (the last Block used to show "$ ").
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 4, endLine: 5, nextStartLine: Infinity, lineCount: 6 }),
      5,
    );
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 0, endLine: 2, nextStartLine: 2, lineCount: 6 }),
      2,
    );
    // `printf x` ends mid-row: the shared row 3 stays with that Block instead
    // of the Block reporting "no output".
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 2, endLine: 4, endSharesNextRow: true, nextStartLine: 3, lineCount: 6 }),
      4,
    );
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 2, endLine: 4, nextStartLine: 3, lineCount: 6 }),
      3,
    );
    // Still running (no end yet): bounded by the next start and the buffer.
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 4, nextStartLine: Infinity, lineCount: 6 }),
      6,
    );
    assert.equal(
      resolveTerminalBlockEnd({ startLine: 4, endLine: 2, nextStartLine: 9, lineCount: 6 }),
      4,
    );
    console.log("PASS block end excludes the next prompt row and keeps a shared output row");
  }

  console.log("All terminal block model extreme tests passed.");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
