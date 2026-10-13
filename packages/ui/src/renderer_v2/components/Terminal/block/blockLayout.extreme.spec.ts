import assert from "node:assert/strict";
import {
  BLOCK_EXPANDED_ROW_LIMIT,
  BLOCK_FOLD_THRESHOLD_ROWS,
  BLOCK_FOLDED_TAIL_ROWS,
  BLOCK_DETAILS_MIN_WIDTH_PX,
  BLOCK_DETAILS_SIDE_MIN_WIDTH_PX,
  BLOCK_LIST_MAX_WIDTH_PX,
  BLOCK_LIST_MIN_WIDTH_PX,
  BLOCK_LIVE_ROW_LIMIT,
  moveRovingId,
  reduceBlockFocus,
  resolveBlockOutputWindow,
  resolveBlockDetailsPlacement,
  resolveBlockDetailsWidth,
  resolveBlockListWidth,
  resolveRovingId,
  type BlockFocusEvent,
  type BlockFocusState,
} from "./blockLayout";

// Details placement and width.
assert.equal(resolveBlockDetailsPlacement(0), "inline");
assert.equal(resolveBlockDetailsPlacement(BLOCK_DETAILS_SIDE_MIN_WIDTH_PX - 1), "inline");
assert.equal(resolveBlockDetailsPlacement(BLOCK_DETAILS_SIDE_MIN_WIDTH_PX), "side");
assert.equal(resolveBlockDetailsPlacement(1920), "side");
assert.equal(resolveBlockDetailsWidth(720), 400);
assert.equal(resolveBlockDetailsWidth(1000), 600);
assert.equal(resolveBlockDetailsWidth(1600), 1600 - BLOCK_LIST_MAX_WIDTH_PX);
assert.equal(resolveBlockDetailsWidth(-20), BLOCK_DETAILS_MIN_WIDTH_PX);
for (let width = BLOCK_DETAILS_SIDE_MIN_WIDTH_PX; width <= 4000; width += 37) {
  const details = resolveBlockDetailsWidth(width);
  const list = width - details;
  assert.ok(details >= BLOCK_DETAILS_MIN_WIDTH_PX);
  assert.ok(list >= BLOCK_LIST_MIN_WIDTH_PX && list <= BLOCK_LIST_MAX_WIDTH_PX, `list ${list} at ${width}`);
  assert.ok(details >= list, "details (full output) gets the larger share");
  assert.equal(resolveBlockListWidth(width), list);
}

// Output density: short output is never folded; only older long blocks fold.
{
  const win = (rows: number, live: boolean, expanded: boolean) =>
    resolveBlockOutputWindow({ outputStart: 100, end: 100 + rows, live, expanded });
  const short = win(BLOCK_FOLD_THRESHOLD_ROWS, false, false);
  assert.deepEqual(short, { start: 100, hidden: 0, expandable: false, collapsible: false });
  const long = win(56, false, false);
  assert.equal(long.hidden, 56 - BLOCK_FOLDED_TAIL_ROWS, "older long block folds to its tail");
  assert.equal(long.start, 156 - BLOCK_FOLDED_TAIL_ROWS);
  assert.equal(long.expandable, true);
  assert.equal(long.collapsible, false);
  const opened = win(56, false, true);
  assert.deepEqual(opened, { start: 100, hidden: 0, expandable: false, collapsible: true });
  const latest = win(120, true, false);
  assert.deepEqual(latest, { start: 100, hidden: 0, expandable: false, collapsible: false },
    "the newest / running block reads like a terminal");
  const huge = win(BLOCK_LIVE_ROW_LIMIT + 50, true, false);
  assert.equal(huge.hidden, 50);
  assert.equal(huge.expandable, true);
  const hugeOpen = win(BLOCK_EXPANDED_ROW_LIMIT + 7, true, true);
  assert.equal(hugeOpen.hidden, 7, "expanded output is capped; the rest is in Terminal");
  assert.equal(hugeOpen.expandable, false);
  assert.equal(hugeOpen.collapsible, true);
  assert.deepEqual(win(0, false, false), { start: 100, hidden: 0, expandable: false, collapsible: false });
  // Invariant: rendered + hidden rows always equal the block's output rows.
  for (const rows of [0, 1, 3, 10, 11, 57, 400, 3000]) {
    for (const live of [false, true]) {
      for (const expanded of [false, true]) {
        const w = win(rows, live, expanded);
        assert.equal(100 + rows - w.start + w.hidden, rows);
        assert.ok(w.start >= 100 && w.start <= 100 + rows);
      }
    }
  }
}

// Focus reducer: header focus inspects, output focus expands.
const apply = (events: BlockFocusEvent[], from: BlockFocusState = {}) =>
  events.reduce(reduceBlockFocus, from);

// Collapsing folds only the expanded block and keeps the details open.
{
  const open = apply([{ type: "focus-header", id: "a", expand: true }]);
  assert.deepEqual(reduceBlockFocus(open, { type: "collapse-output", id: "a" }), {
    activeId: "a",
    inspectedId: "a",
    expandedId: undefined,
  });
  assert.equal(reduceBlockFocus(open, { type: "collapse-output", id: "b" }), open);
}

// Narrow layout: header focus opens the block in place instead of a side pane.
assert.deepEqual(apply([{ type: "focus-header", id: "a", expand: true }]), {
  activeId: "a",
  inspectedId: "a",
  expandedId: "a",
});

assert.deepEqual(apply([{ type: "focus-header", id: "a" }]), {
  activeId: "a",
  inspectedId: "a",
  expandedId: undefined,
});
assert.deepEqual(apply([{ type: "expand-output", id: "a" }]), {
  activeId: "a",
  expandedId: "a",
});
// Expanding closes the details (focus moved into stream content).
assert.deepEqual(
  apply([
    { type: "focus-header", id: "a" },
    { type: "expand-output", id: "a" },
  ]),
  { activeId: "a", expandedId: "a" },
);
// Inspecting the expanded block keeps it expanded; another block collapses it.
assert.deepEqual(
  apply([
    { type: "expand-output", id: "a" },
    { type: "focus-header", id: "a" },
  ]),
  { activeId: "a", expandedId: "a", inspectedId: "a" },
);
assert.deepEqual(
  apply([
    { type: "expand-output", id: "a" },
    { type: "focus-header", id: "b" },
  ]),
  { activeId: "b", expandedId: undefined, inspectedId: "b" },
);
// Only one block is ever expanded.
assert.deepEqual(
  apply([
    { type: "expand-output", id: "a" },
    { type: "expand-output", id: "b" },
  ]),
  { activeId: "b", expandedId: "b" },
);
// Release (Escape, stream background, dock) collapses everything but keeps the tab stop.
assert.deepEqual(
  apply([
    { type: "focus-header", id: "a" },
    { type: "expand-output", id: "a" },
    { type: "focus-header", id: "a" },
    { type: "release" },
  ]),
  { activeId: "a" },
);
// Prune drops ids of blocks that disappeared.
assert.deepEqual(
  apply([{ type: "prune", ids: ["b"] }], {
    activeId: "a",
    expandedId: "b",
    inspectedId: "a",
  }),
  { activeId: undefined, expandedId: "b", inspectedId: undefined },
);
// No-op events return the same object.
{
  const state: BlockFocusState = { activeId: "a" };
  assert.equal(reduceBlockFocus(state, { type: "release" }), state);
  assert.equal(reduceBlockFocus(state, { type: "prune", ids: ["a", "b"] }), state);
  const inspected = apply([{ type: "focus-header", id: "a" }]);
  assert.equal(reduceBlockFocus(inspected, { type: "focus-header", id: "a" }), inspected);
}

// Invariants over random event sequences.
{
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const ids = ["a", "b", "c", "d"];
  let state: BlockFocusState = {};
  for (let step = 0; step < 5000; step += 1) {
    const id = ids[Math.floor(random() * ids.length)];
    const pick = Math.floor(random() * 4);
    const event: BlockFocusEvent =
      pick === 0
        ? { type: "focus-header", id }
        : pick === 1
          ? { type: "expand-output", id }
          : pick === 2
            ? { type: "release" }
            : { type: "prune", ids: ids.filter(() => random() > 0.2) };
    state = reduceBlockFocus(state, event);
    if (state.inspectedId) assert.equal(state.inspectedId, state.activeId);
    if (state.expandedId && event.type !== "prune")
      assert.equal(state.expandedId, state.activeId);
    if (event.type === "release") {
      assert.equal(state.expandedId, undefined);
      assert.equal(state.inspectedId, undefined);
    }
  }
}

// Roving tab stop.
const blocks = ["a", "b", "c"];
assert.equal(moveRovingId([], undefined, 1), undefined);
assert.equal(moveRovingId(blocks, undefined, -1), "c");
assert.equal(moveRovingId(blocks, undefined, 1), "c");
assert.equal(moveRovingId(blocks, "missing", -1), "c");
assert.equal(moveRovingId(blocks, "c", -1), "b");
assert.equal(moveRovingId(blocks, "b", 1), "c");
assert.equal(moveRovingId(blocks, "a", -1), "a", "clamped at the oldest");
assert.equal(moveRovingId(blocks, "c", 1), "c", "clamped at the latest");
assert.equal(resolveRovingId(blocks, undefined), "c");
assert.equal(resolveRovingId(blocks, "a"), "a");
assert.equal(resolveRovingId(blocks, "gone"), "c");
assert.equal(resolveRovingId([], undefined), undefined);

console.log(
  "PASS block layout: details placement, output density, focus-driven expansion/inspection, and roving tab stop",
);
