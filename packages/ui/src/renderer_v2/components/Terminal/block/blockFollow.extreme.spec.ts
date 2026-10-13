import assert from "node:assert/strict";
import {
  BLOCK_USER_SCROLL_INTENT_MS,
  INITIAL_BLOCK_FOLLOW_STATE,
  classifyBlockScroll,
  hasBlockOverflow,
  isBlockScrollKey,
  isBlockScrollUpKey,
  isBlockScrolledToBottom,
  reduceBlockFollow,
  unseenBlockLineCount,
  type BlockFollowEvent,
  type BlockFollowState,
} from "./blockFollow";

const run = (events: [BlockFollowEvent, number][]): BlockFollowState =>
  events.reduce(
    (state, [event, lineFeeds]) => reduceBlockFollow(state, event, lineFeeds),
    INITIAL_BLOCK_FOLLOW_STATE,
  );

// Starts following; nothing is unseen while following.
assert.equal(INITIAL_BLOCK_FOLLOW_STATE.following, true);
assert.equal(unseenBlockLineCount(INITIAL_BLOCK_FOLLOW_STATE, 500), 0);

// Every user-initiated way of looking at older content pauses following.
for (const event of [
  { type: "user-scroll", atBottom: false },
  { type: "scroll-up-intent" },
  { type: "navigate", toLatest: false },
  { type: "select-text" },
] as BlockFollowEvent[]) {
  const paused = reduceBlockFollow(INITIAL_BLOCK_FOLLOW_STATE, event, 10);
  assert.deepEqual(paused, { following: false, pausedAtLineFeed: 10 }, event.type);
  assert.equal(unseenBlockLineCount(paused, 10), 0);
  assert.equal(unseenBlockLineCount(paused, 17), 7);
}

// Every way back to the latest output resumes following.
for (const event of [
  { type: "user-scroll", atBottom: true },
  { type: "jump-to-latest" },
  { type: "typed" },
] as BlockFollowEvent[]) {
  const resumed = run([
    [{ type: "scroll-up-intent" }, 3],
    [event, 9],
  ]);
  assert.deepEqual(resumed, { following: true, pausedAtLineFeed: 9 }, event.type);
  assert.equal(unseenBlockLineCount(resumed, 50), 0);
}

// Navigating to the latest block neither pauses nor resumes.
{
  const following = reduceBlockFollow(
    INITIAL_BLOCK_FOLLOW_STATE,
    { type: "navigate", toLatest: true },
    4,
  );
  assert.equal(following, INITIAL_BLOCK_FOLLOW_STATE, "same object: no re-render");
  const paused = run([[{ type: "select-text" }, 2]]);
  assert.equal(
    reduceBlockFollow(paused, { type: "navigate", toLatest: true }, 8),
    paused,
  );
}

// Pausing again keeps the original baseline so "N new" keeps counting.
{
  const state = run([
    [{ type: "scroll-up-intent" }, 100],
    [{ type: "user-scroll", atBottom: false }, 140],
    [{ type: "select-text" }, 160],
    [{ type: "navigate", toLatest: false }, 170],
  ]);
  assert.deepEqual(state, { following: false, pausedAtLineFeed: 100 });
  assert.equal(unseenBlockLineCount(state, 175), 75);
}

// Resuming when already following returns the same object.
assert.equal(
  reduceBlockFollow(INITIAL_BLOCK_FOLLOW_STATE, { type: "typed" }, 99),
  INITIAL_BLOCK_FOLLOW_STATE,
);

// The unseen count never goes negative (e.g. after a terminal reset).
assert.equal(
  unseenBlockLineCount({ following: false, pausedAtLineFeed: 50 }, 10),
  0,
);

// Bottom detection with tolerance for fractional layout.
assert.equal(
  isBlockScrolledToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }),
  true,
);
assert.equal(
  isBlockScrolledToBottom({ scrollTop: 597.5, scrollHeight: 1000, clientHeight: 400 }),
  true,
);
assert.equal(
  isBlockScrolledToBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 }),
  false,
);
assert.equal(
  isBlockScrolledToBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 }),
  true,
  "content shorter than the viewport is always at the bottom",
);
assert.equal(hasBlockOverflow({ scrollHeight: 300, clientHeight: 400 }), false);
assert.equal(hasBlockOverflow({ scrollHeight: 402, clientHeight: 400 }), false);
assert.equal(hasBlockOverflow({ scrollHeight: 900, clientHeight: 400 }), true);

// Scroll classification: programmatic writes win, then recent user intent.
assert.equal(
  classifyBlockScroll({
    scrollTop: 600,
    programmaticScrollTop: 600,
    lastUserIntentAt: 1000,
    now: 1001,
  }),
  "programmatic",
  "our own write is never mistaken for the user, even during intent",
);
assert.equal(
  classifyBlockScroll({
    scrollTop: 480,
    programmaticScrollTop: 600,
    lastUserIntentAt: 1000,
    now: 1100,
  }),
  "user",
);
assert.equal(
  classifyBlockScroll({
    scrollTop: 480,
    lastUserIntentAt: 1000,
    now: 1000 + BLOCK_USER_SCROLL_INTENT_MS,
  }),
  "user",
);
assert.equal(
  classifyBlockScroll({
    scrollTop: 480,
    lastUserIntentAt: 1000,
    now: 1001 + BLOCK_USER_SCROLL_INTENT_MS,
  }),
  "layout",
  "reflow/clamping without input must not pause following",
);
assert.equal(
  classifyBlockScroll({ scrollTop: 0, lastUserIntentAt: -Infinity, now: 0 }),
  "layout",
);

// Keys.
assert.ok(isBlockScrollUpKey("PageUp") && isBlockScrollUpKey("Home"));
assert.ok(!isBlockScrollUpKey("PageDown") && !isBlockScrollUpKey("a"));
for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"])
  assert.ok(isBlockScrollKey(key), key);
for (const key of ["a", " ", "Enter", "Escape", "Tab"])
  assert.ok(!isBlockScrollKey(key), key);

// Randomized model check against a straightforward reference.
{
  let seed = 42;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const events: BlockFollowEvent[] = [
    { type: "user-scroll", atBottom: false },
    { type: "user-scroll", atBottom: true },
    { type: "scroll-up-intent" },
    { type: "navigate", toLatest: false },
    { type: "navigate", toLatest: true },
    { type: "select-text" },
    { type: "jump-to-latest" },
    { type: "typed" },
  ];
  let state = INITIAL_BLOCK_FOLLOW_STATE;
  let following = true;
  let baseline = 0;
  let lineFeeds = 0;
  for (let step = 0; step < 5000; step += 1) {
    lineFeeds += Math.floor(random() * 4);
    const event = events[Math.floor(random() * events.length)];
    state = reduceBlockFollow(state, event, lineFeeds);
    const resumes =
      event.type === "jump-to-latest" ||
      event.type === "typed" ||
      (event.type === "user-scroll" && event.atBottom);
    const keeps = event.type === "navigate" && event.toLatest;
    if (resumes) {
      if (!following) baseline = lineFeeds;
      following = true;
    } else if (!keeps) {
      if (following) baseline = lineFeeds;
      following = false;
    }
    assert.equal(state.following, following);
    if (!following) assert.equal(state.pausedAtLineFeed, baseline);
    assert.ok(unseenBlockLineCount(state, lineFeeds) >= 0);
  }
}

console.log(
  "PASS block follow: pause/resume rules, stable baselines, scroll source classification, and model check",
);
