/**
 * Focus-driven layout of the Block stream. One view; where focus sits decides
 * which block is expanded and whether its details are shown. Pure and DOM-free.
 *
 * A block is one button: clicking a closed block (not a drag-selection) or
 * Enter/Space on its header opens it. Boards at least
 * BLOCK_DETAILS_SIDE_MIN_WIDTH_PX wide split into list | details; narrower
 * boards open the details in place with all output. An open block closes from
 * its header or Escape; clicks in its body are left for reading/selecting.
 * Headers form a roving tab stop (ArrowUp/ArrowDown).
 */

/** Below this board width the details render in place under the header. */
export const BLOCK_DETAILS_SIDE_MIN_WIDTH_PX = 720;
export const BLOCK_DETAILS_MIN_WIDTH_PX = 280;
/** Split layout: the Block list is a narrow navigator (40%, 320-560 px). */
export const BLOCK_LIST_MIN_WIDTH_PX = 320;
export const BLOCK_LIST_MAX_WIDTH_PX = 560;
const BLOCK_LIST_WIDTH_RATIO = 0.4;
/**
 * Output density. The stream reads like a terminal transcript: short output is
 * always shown in full, the newest (or a running) block shows its latest rows
 * up to a small live limit, and older LONG blocks fold to a shorter tail.
 * Nothing opens in full by default; opening a block shows all of it. Folding
 * never overlays content; hidden rows are counted on the header.
 */
/** Older blocks with more rows than this fold to their tail. */
export const BLOCK_FOLD_THRESHOLD_ROWS = 10;
/** Tail rows kept visible when an older block is folded. */
export const BLOCK_FOLDED_TAIL_ROWS = 3;
/** Tail rows shown for the newest / running block before folding the head. */
export const BLOCK_LIVE_ROW_LIMIT = 25;
/** Hard cap on rows rendered for one expanded block or the details pane. */
export const BLOCK_EXPANDED_ROW_LIMIT = 2400;

export type BlockDetailsPlacement = "side" | "inline";

export const resolveBlockDetailsPlacement = (
  containerWidth: number,
): BlockDetailsPlacement =>
  containerWidth >= BLOCK_DETAILS_SIDE_MIN_WIDTH_PX ? "side" : "inline";

export const resolveBlockListWidth = (containerWidth: number): number =>
  Math.round(
    Math.min(
      BLOCK_LIST_MAX_WIDTH_PX,
      Math.max(BLOCK_LIST_MIN_WIDTH_PX, Math.max(0, containerWidth) * BLOCK_LIST_WIDTH_RATIO),
    ),
  );

/**
 * The details pane holds the full output, so it gets the larger share; the
 * list keeps enough room for a header (command, duration, status).
 */
export const resolveBlockDetailsWidth = (containerWidth: number): number =>
  Math.max(
    BLOCK_DETAILS_MIN_WIDTH_PX,
    Math.round(Math.max(0, containerWidth)) - resolveBlockListWidth(containerWidth),
  );

interface BlockOutputWindow {
  /** First buffer row rendered. */
  start: number;
  /** Rows above `start` that are not rendered. */
  hidden: number;
  /** True when the hidden rows can be revealed by expanding in place. */
  expandable: boolean;
  /** True when the block can be folded back (it is expanded and long). */
  collapsible: boolean;
}

export const resolveBlockOutputWindow = (input: {
  outputStart: number;
  end: number;
  /** Newest block, or a block that is still running. */
  live: boolean;
  expanded: boolean;
}): BlockOutputWindow => {
  const outputStart = Math.max(0, Math.floor(input.outputStart));
  const end = Math.max(outputStart, Math.floor(input.end));
  const rows = end - outputStart;
  const foldable = !input.live && rows > BLOCK_FOLD_THRESHOLD_ROWS;
  const limit = input.expanded
    ? BLOCK_EXPANDED_ROW_LIMIT
    : input.live
      ? BLOCK_LIVE_ROW_LIMIT
      : foldable
        ? BLOCK_FOLDED_TAIL_ROWS
        : rows;
  const shown = Math.min(rows, limit);
  const hidden = rows - shown;
  return {
    start: end - shown,
    hidden,
    expandable: hidden > 0 && !input.expanded,
    collapsible: input.expanded && (foldable || rows > BLOCK_LIVE_ROW_LIMIT),
  };
};

export interface BlockFocusState {
  /** Roving tab stop; survives release so Tab returns to the same block. */
  activeId?: string;
  expandedId?: string;
  inspectedId?: string;
}

export type BlockFocusEvent =
  /**
   * Header focus reveals the details for that block. `expand` is set where
   * there is no room for the split pane: the block then opens in place.
   */
  | { type: "focus-header"; id: string; expand?: boolean }
  /** Output focus (click, Enter/Space) expands that block inline. */
  | { type: "expand-output"; id: string }
  /** Fold an expanded block back without leaving it. */
  | { type: "collapse-output"; id: string }
  /** Focus went to stream background or the dock, or Escape was pressed. */
  | { type: "release" }
  /** Drop ids whose blocks no longer exist. */
  | { type: "prune"; ids: readonly string[] };

const sameFocus = (left: BlockFocusState, right: BlockFocusState): boolean =>
  left.activeId === right.activeId &&
  left.expandedId === right.expandedId &&
  left.inspectedId === right.inspectedId;

/** Returns the same object when nothing changes so React can bail out. */
export const reduceBlockFocus = (
  state: BlockFocusState,
  event: BlockFocusEvent,
): BlockFocusState => {
  let next: BlockFocusState;
  switch (event.type) {
    case "focus-header":
      next = {
        activeId: event.id,
        inspectedId: event.id,
        // Header and output are one unit: inspecting the expanded block keeps
        // it expanded; inspecting another block collapses the old one.
        expandedId:
          event.expand || state.expandedId === event.id ? event.id : undefined,
      };
      break;
    case "expand-output":
      next = { activeId: event.id, expandedId: event.id };
      break;
    case "collapse-output":
      next =
        state.expandedId === event.id
          ? { ...state, activeId: event.id, expandedId: undefined }
          : state;
      break;
    case "release":
      next = { activeId: state.activeId };
      break;
    case "prune": {
      const ids = new Set(event.ids);
      const keep = (id?: string) => (id && ids.has(id) ? id : undefined);
      next = {
        activeId: keep(state.activeId),
        expandedId: keep(state.expandedId),
        inspectedId: keep(state.inspectedId),
      };
      break;
    }
  }
  return sameFocus(state, next) ? state : next;
};

/** Roving tab stop movement; with no current block both directions start at the latest. */
export const moveRovingId = (
  ids: readonly string[],
  currentId: string | undefined,
  direction: -1 | 1,
): string | undefined => {
  if (ids.length === 0) return undefined;
  const index = currentId ? ids.indexOf(currentId) : -1;
  if (index < 0) return ids[ids.length - 1];
  return ids[Math.max(0, Math.min(ids.length - 1, index + direction))];
};

/** The block that owns the roving tab stop when none is active yet. */
export const resolveRovingId = (
  ids: readonly string[],
  activeId: string | undefined,
): string | undefined =>
  activeId && ids.includes(activeId) ? activeId : ids[ids.length - 1];
