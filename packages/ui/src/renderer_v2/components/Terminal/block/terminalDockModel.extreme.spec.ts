import assert from "node:assert/strict";
import {
  EMPTY_TERMINAL_DOCK_STATE,
  TERMINAL_DOCK_IDLE_ROWS,
  TERMINAL_DOCK_MAX_ROWS,
  resolveListedBlockEnd,
  resolveTerminalDockAnchor,
  resolveTerminalDockWindow,
  terminalDockGeometry,
  terminalDockMaxRows,
} from "./terminalDockModel";

// --- maxRows: ~40% of the available height, capped at 12 rows, at least 1.
assert.equal(terminalDockMaxRows(800, 20), TERMINAL_DOCK_MAX_ROWS);
assert.equal(terminalDockMaxRows(300, 20), 6);
assert.equal(terminalDockMaxRows(10, 20), 1);
assert.equal(terminalDockMaxRows(0, 20), 1);
assert.equal(terminalDockMaxRows(500, 0), 1);
assert.equal(terminalDockMaxRows(Number.NaN, 18), 1);

// --- Idle: single-line prompt is one row.
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 39,
    contentBottomRow: 39,
    logicalStartRow: 39,
    maxRows: 12,
  }),
  { topRow: 39, bottomRow: 39, rows: 1 },
);

// --- Idle: two-line prompt (prompt starts at the last command's end marker).
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 20,
    contentBottomRow: 20,
    logicalStartRow: 20,
    promptStartRow: 19,
    maxRows: 12,
  }),
  { topRow: 19, bottomRow: 20, rows: 2 },
);

// --- Idle: a stale prompt anchor far above never shows more than the idle rows.
assert.equal(
  resolveTerminalDockWindow({
    cursorRow: 30,
    contentBottomRow: 30,
    logicalStartRow: 30,
    promptStartRow: 2,
    maxRows: 12,
  }).rows,
  TERMINAL_DOCK_IDLE_ROWS,
);

// --- Idle: a prompt anchor below the cursor is ignored.
assert.equal(
  resolveTerminalDockWindow({
    cursorRow: 10,
    contentBottomRow: 10,
    logicalStartRow: 10,
    promptStartRow: 12,
    maxRows: 12,
  }).rows,
  1,
);

// --- Idle: a long soft-wrapped input line may exceed the idle size, up to maxRows.
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 30,
    contentBottomRow: 30,
    logicalStartRow: 25,
    maxRows: 12,
  }),
  { topRow: 25, bottomRow: 30, rows: 6 },
);
assert.equal(
  resolveTerminalDockWindow({
    cursorRow: 30,
    contentBottomRow: 30,
    logicalStartRow: 2,
    maxRows: 12,
  }).rows,
  12,
);

// --- Running: grows with the command's output, capped at maxRows.
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 30,
    contentBottomRow: 30,
    logicalStartRow: 30,
    runningStartRow: 26,
    promptStartRow: 25,
    maxRows: 12,
  }),
  { topRow: 26, bottomRow: 30, rows: 5 },
);
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 30,
    contentBottomRow: 30,
    logicalStartRow: 30,
    runningStartRow: -400,
    maxRows: 12,
  }),
  { topRow: 19, bottomRow: 30, rows: 12 },
);

// --- Running: password prompt (no echo) right below the command stays visible.
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 15,
    contentBottomRow: 15,
    logicalStartRow: 15,
    runningStartRow: 14,
    maxRows: 12,
  }),
  { topRow: 14, bottomRow: 15, rows: 2 },
);

// --- A zsh completion menu below the cursor is revealed, cursor stays inside.
{
  const window = resolveTerminalDockWindow({
    cursorRow: 10,
    contentBottomRow: 14,
    logicalStartRow: 10,
    maxRows: 12,
  });
  assert.deepEqual(window, { topRow: 10, bottomRow: 14, rows: 5 });
  const huge = resolveTerminalDockWindow({
    cursorRow: 10,
    contentBottomRow: 60,
    logicalStartRow: 10,
    maxRows: 6,
  });
  assert.deepEqual(huge, { topRow: 10, bottomRow: 15, rows: 6 });
}

// --- After `clear`: the prompt is at row 0; never reveal negative rows.
assert.deepEqual(
  resolveTerminalDockWindow({
    cursorRow: 0,
    contentBottomRow: 0,
    logicalStartRow: 0,
    promptStartRow: -5,
    runningStartRow: undefined,
    maxRows: 12,
  }),
  { topRow: 0, bottomRow: 0, rows: 1 },
);

// --- Property sweep: invariants hold for arbitrary inputs.
for (const cursorRow of [0, 1, 5, 23, 39]) {
  for (const below of [0, 1, 4, 30]) {
    for (const logicalBack of [0, 1, 7]) {
      for (const running of [undefined, -50, cursorRow - 3, cursorRow, cursorRow + 2]) {
        for (const prompt of [undefined, -10, cursorRow - 1, cursorRow + 1]) {
          for (const maxRows of [1, 3, 6, 12]) {
            const result = resolveTerminalDockWindow({
              cursorRow,
              contentBottomRow: cursorRow + below,
              logicalStartRow: Math.max(0, cursorRow - logicalBack),
              runningStartRow: running,
              promptStartRow: prompt,
              maxRows,
            });
            assert.ok(result.topRow >= 0, "no negative rows");
            assert.ok(result.topRow <= cursorRow, "cursor below top");
            assert.ok(result.bottomRow >= cursorRow, "cursor above bottom");
            assert.ok(result.rows >= 1 && result.rows <= maxRows, "row cap");
            assert.equal(result.rows, result.bottomRow - result.topRow + 1);
            const isRunning = running !== undefined && running <= cursorRow;
            if (!isRunning && logicalBack === 0 && below === 0) {
              assert.ok(result.rows <= TERMINAL_DOCK_IDLE_ROWS, "idle shrinks");
            }
          }
        }
      }
    }
  }
}

// --- Geometry: the window's bottom row lands at the aperture bottom, above the footer.
for (const hostHeight of [0, 100, 280, 800, 1200]) {
  for (const rowHeight of [14, 18.5, 28]) {
    for (const inset of [0, 30]) {
      const rows = Math.max(1, Math.floor(hostHeight / rowHeight));
      for (const bottomRow of [0, Math.floor(rows / 2), rows - 1]) {
        for (const windowRows of [1, 3, 12]) {
          const dock = {
            topRow: Math.max(0, bottomRow - windowRows + 1),
            bottomRow,
            rows: Math.min(windowRows, bottomRow + 1),
          };
          const geometry = terminalDockGeometry(
            hostHeight,
            rowHeight,
            dock,
            inset,
          );
          const available = Math.max(0, hostHeight - inset);
          assert.ok(geometry.height <= available + 1e-9);
          assert.ok(geometry.height <= dock.rows * rowHeight + 1e-9);
          assert.equal(geometry.clipBottom, inset);
          assert.ok(
            Math.abs(geometry.clipTop + geometry.height - available) < 1e-9,
          );
          assert.ok(
            Math.abs(
              geometry.offset + (bottomRow + 1) * rowHeight - available,
            ) < 1e-9,
            "bottom row sits exactly at the aperture bottom",
          );
        }
      }
    }
  }
}

// Regression: a cursor on the last terminal row must not hide under the footer.
{
  const geometry = terminalDockGeometry(
    800,
    20,
    { topRow: 39, bottomRow: 39, rows: 1 },
    30,
  );
  assert.deepEqual(geometry, {
    height: 20,
    clipTop: 750,
    clipBottom: 30,
    offset: -30,
  });
}

// --- Anchor resolution from Activity snapshots and markers.
{
  const marker = (line: number, isDisposed = false) => ({ line, isDisposed });
  const ranges = new Map([
    ["a", { start: marker(2), end: marker(8) }],
    ["b", { start: marker(9), end: marker(20) }],
    ["c", { start: marker(21) }],
    ["d", { start: marker(30, true) }],
  ]);
  const get = (id: string) => ranges.get(id);
  assert.deepEqual(
    resolveTerminalDockAnchor(
      [
        { id: "a", status: "succeeded" },
        { id: "b", status: "failed" },
        { id: "c", status: "running" },
        { id: "d", status: "running" },
      ],
      get,
    ),
    { runningStartLine: 21, promptStartLine: 20 },
  );
  // A completed command below a stale "running" one wins.
  assert.deepEqual(
    resolveTerminalDockAnchor(
      [
        { id: "c", status: "running" },
        { id: "x", status: "succeeded" },
      ],
      (id) => (id === "x" ? { start: marker(22), end: marker(25) } : get(id)),
    ),
    { runningStartLine: undefined, promptStartLine: 25 },
  );
  assert.deepEqual(resolveTerminalDockAnchor([], get), {
    runningStartLine: undefined,
    promptStartLine: undefined,
  });
  assert.deepEqual(
    resolveTerminalDockAnchor([{ id: "missing", status: "running" }], get),
    { runningStartLine: undefined, promptStartLine: undefined },
  );
}

// --- Listed rows: the running block stops where the dock begins (the dock
// shows the rest live), so no row is ever on screen twice.
{
  const block = { outputStart: 100, end: 160 };
  // Rows 148.. are in the dock; the list ends right above them.
  assert.equal(
    resolveListedBlockEnd({ ...block, running: true, dockTopLine: 148 }),
    148,
  );
  // Everything still fits in the dock: header only, no listed rows.
  assert.equal(
    resolveListedBlockEnd({ ...block, running: true, dockTopLine: 100 }),
    100,
  );
  // Dock starts at the command echo (above the output): never below start.
  assert.equal(
    resolveListedBlockEnd({ ...block, running: true, dockTopLine: 99 }),
    100,
  );
  // Dock below the block (a completion menu, stale runner): list it all.
  assert.equal(
    resolveListedBlockEnd({ ...block, running: true, dockTopLine: 400 }),
    160,
  );
  // Settled blocks always list everything; the dock then shows the prompt.
  assert.equal(
    resolveListedBlockEnd({ ...block, running: false, dockTopLine: 148 }),
    160,
  );
  // No dock (hidden, native screen, other view mode): list everything.
  assert.equal(
    resolveListedBlockEnd({
      ...block,
      running: true,
      dockTopLine: EMPTY_TERMINAL_DOCK_STATE.topLine,
    }),
    160,
  );
  assert.equal(EMPTY_TERMINAL_DOCK_STATE.height, 0);
  assert.ok(Object.isFrozen(EMPTY_TERMINAL_DOCK_STATE));
  // Invariant over every split point: listed + docked = the whole output,
  // with no overlap and no gap.
  for (let top = 90; top <= 170; top += 1) {
    const listed = resolveListedBlockEnd({
      ...block,
      running: true,
      dockTopLine: top,
    });
    assert.ok(listed >= block.outputStart && listed <= block.end);
    const dockedFrom = Math.min(Math.max(top, block.outputStart), block.end);
    assert.equal(listed, dockedFrom);
  }
}

console.log(
  "PASS docked prompt: idle/running/wrapped/completion windows, footer-safe geometry, Activity anchors, and running blocks listed only above the dock",
);
