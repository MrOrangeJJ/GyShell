/**
 * "Stick to bottom" decisions for the Block stream. Pure and DOM-free so the
 * rules that decide when the stream follows new output can be tested.
 *
 * Output growth is measured in xterm line feeds (a monotonic counter), which
 * keeps the unseen count correct even when scrollback trimming keeps the
 * buffer length constant.
 *
 * The stream follows new output until the user looks elsewhere: wheel/touch
 * scroll up, PageUp/Home/arrow keys, keyboard navigation to an older block,
 * or a text selection in the stream. While paused, an "N new · Jump to
 * latest" pill counts line feeds since the pause. Following resumes at the
 * bottom, from the pill, or when the user types into the docked prompt.
 */

const BLOCK_FOLLOW_BOTTOM_TOLERANCE_PX = 4;
/** A scroll counts as user-initiated only this soon after wheel/touch/key/pointer input. */
export const BLOCK_USER_SCROLL_INTENT_MS = 700;

export interface BlockFollowState {
  following: boolean;
  /** Line-feed count when following paused; the baseline for "N new". */
  pausedAtLineFeed: number;
}

export const INITIAL_BLOCK_FOLLOW_STATE: BlockFollowState = {
  following: true,
  pausedAtLineFeed: 0,
};

export type BlockFollowEvent =
  /** A scroll event classified as user-initiated. */
  | { type: "user-scroll"; atBottom: boolean }
  /** Wheel/touch/PageUp intent toward older content, before the scroll lands. */
  | { type: "scroll-up-intent" }
  /** Keyboard/pointer focus moved to a block. */
  | { type: "navigate"; toLatest: boolean }
  | { type: "select-text" }
  | { type: "jump-to-latest" }
  /** The user typed into the docked prompt. */
  | { type: "typed" };

const pause = (state: BlockFollowState, lineFeeds: number): BlockFollowState =>
  state.following ? { following: false, pausedAtLineFeed: lineFeeds } : state;

const resume = (state: BlockFollowState, lineFeeds: number): BlockFollowState =>
  state.following ? state : { following: true, pausedAtLineFeed: lineFeeds };

/** Returns the same object when nothing changes so React can bail out. */
export const reduceBlockFollow = (
  state: BlockFollowState,
  event: BlockFollowEvent,
  lineFeeds: number,
): BlockFollowState => {
  switch (event.type) {
    case "user-scroll":
      return event.atBottom ? resume(state, lineFeeds) : pause(state, lineFeeds);
    case "scroll-up-intent":
    case "select-text":
      return pause(state, lineFeeds);
    case "navigate":
      return event.toLatest ? state : pause(state, lineFeeds);
    case "jump-to-latest":
    case "typed":
      return resume(state, lineFeeds);
  }
};

export const unseenBlockLineCount = (
  state: BlockFollowState,
  lineFeeds: number,
): number =>
  state.following ? 0 : Math.max(0, lineFeeds - state.pausedAtLineFeed);

export const isBlockScrolledToBottom = (
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  tolerance = BLOCK_FOLLOW_BOTTOM_TOLERANCE_PX,
): boolean =>
  metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= tolerance;

/** Whether there is anything above the viewport to scroll toward. */
export const hasBlockOverflow = (
  metrics: { scrollHeight: number; clientHeight: number },
  tolerance = BLOCK_FOLLOW_BOTTOM_TOLERANCE_PX,
): boolean => metrics.scrollHeight - metrics.clientHeight > tolerance;

type BlockScrollSource = "programmatic" | "user" | "layout";

/**
 * Programmatic writes record the resulting scrollTop; a scroll event landing
 * there is ours. Otherwise only recent wheel/touch/key/pointer input makes it
 * a user scroll; anything else (content reflow, clamping) is layout noise
 * and must not change the follow state.
 */
export const classifyBlockScroll = (input: {
  scrollTop: number;
  programmaticScrollTop?: number;
  lastUserIntentAt: number;
  now: number;
  intentWindowMs?: number;
}): BlockScrollSource => {
  if (
    input.programmaticScrollTop !== undefined &&
    Math.abs(input.scrollTop - input.programmaticScrollTop) < 1
  ) {
    return "programmatic";
  }
  const intentWindow = input.intentWindowMs ?? BLOCK_USER_SCROLL_INTENT_MS;
  return input.now - input.lastUserIntentAt <= intentWindow
    ? "user"
    : "layout";
};

/** Keys that scroll a focused scroll container toward older content. */
export const isBlockScrollUpKey = (key: string): boolean =>
  key === "PageUp" || key === "Home";

/** Keys that may scroll a focused scroll container at all. */
export const isBlockScrollKey = (key: string): boolean =>
  key === "PageUp" ||
  key === "PageDown" ||
  key === "Home" ||
  key === "End" ||
  key === "ArrowUp" ||
  key === "ArrowDown";
