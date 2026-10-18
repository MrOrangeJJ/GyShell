import React from "react";
import type { Terminal } from "@xterm/xterm";
import {
  INITIAL_BLOCK_FOLLOW_STATE,
  classifyBlockScroll,
  hasBlockOverflow,
  isBlockScrolledToBottom,
  reduceBlockFollow,
  unseenBlockLineCount,
  type BlockFollowEvent,
} from "./blockFollow";

/** Focus reports (CSI I / CSI O) are not typing. */
const isFocusReport = (data: string): boolean =>
  data === "\x1b[I" || data === "\x1b[O";

/**
 * Stick-to-bottom following for the Block stream (rules in blockFollow.ts).
 * Owns the DOM side: counting line feeds, telling programmatic scrolls from
 * user scrolls, and re-pinning the stream to the bottom after every render.
 */
export const useBlockStreamFollow = ({
  terminal,
  streamRef,
  enabled,
  visible,
  rowHeight,
}: {
  terminal: Terminal;
  streamRef: React.RefObject<HTMLElement>;
  /** Listen to terminal output/input (view shown in the active panel). */
  enabled: boolean;
  /** Watch text selection in the stream (view shown). */
  visible: boolean;
  /** Line-mode wheel deltas are in rows. */
  rowHeight: number;
}) => {
  const [follow, setFollow] = React.useState(INITIAL_BLOCK_FOLLOW_STATE);
  // Whether anything is below the viewport; the "N new" pill needs both
  // unseen rows and somewhere to jump to (fully visible output is seen).
  const [contentBelow, setContentBelow] = React.useState(false);
  const lineFeeds = React.useRef(0);
  const programmaticScrollTop = React.useRef<number>();
  const lastUserIntentAt = React.useRef(-Infinity);
  const pointerHeld = React.useRef(false);
  const followingRef = React.useRef(follow.following);
  followingRef.current = follow.following;

  const dispatchFollow = React.useCallback((event: BlockFollowEvent) => {
    setFollow((state) => reduceBlockFollow(state, event, lineFeeds.current));
  }, []);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const listeners = [
      terminal.onLineFeed(() => {
        lineFeeds.current += 1;
      }),
      // Typing into the docked prompt means the user is back at the bottom.
      terminal.onData((data) => {
        if (!isFocusReport(data)) dispatchFollow({ type: "typed" });
      }),
    ];
    return () => listeners.forEach((listener) => listener.dispose());
  }, [dispatchFollow, enabled, terminal]);

  /** Marks the stream's current position as set by us, not the user. */
  const recordProgrammaticScroll = React.useCallback(() => {
    const stream = streamRef.current;
    if (stream) programmaticScrollTop.current = stream.scrollTop;
  }, [streamRef]);

  const scrollStreamTo = React.useCallback(
    (top: number) => {
      const stream = streamRef.current;
      if (!stream) return;
      stream.scrollTop = top;
      programmaticScrollTop.current = stream.scrollTop;
    },
    [streamRef],
  );

  const stickToBottom = React.useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !followingRef.current) return;
    const bottom = stream.scrollHeight - stream.clientHeight;
    if (Math.abs(stream.scrollTop - bottom) > 1) scrollStreamTo(bottom);
  }, [scrollStreamTo, streamRef]);

  const measureContentBelow = () => {
    const stream = streamRef.current;
    setContentBelow(!!stream && !isBlockScrolledToBottom(stream));
  };

  // Follow after every render; output, dock and layout changes all land here.
  React.useLayoutEffect(() => {
    stickToBottom();
    measureContentBelow();
  });

  // Pause following while the user selects text in the stream.
  React.useEffect(() => {
    if (!visible) return undefined;
    const handleSelection = () => {
      const selection = document.getSelection();
      const stream = streamRef.current;
      if (
        selection &&
        !selection.isCollapsed &&
        stream &&
        selection.anchorNode &&
        stream.contains(selection.anchorNode)
      ) {
        dispatchFollow({ type: "select-text" });
      }
    };
    document.addEventListener("selectionchange", handleSelection);
    return () =>
      document.removeEventListener("selectionchange", handleSelection);
  }, [dispatchFollow, streamRef, visible]);

  const noteUserIntent = () => {
    lastUserIntentAt.current = performance.now();
    programmaticScrollTop.current = undefined;
  };

  /** Pause only when there is older content to scroll toward. */
  const noteScrollUpIntent = () => {
    const stream = streamRef.current;
    if (stream && hasBlockOverflow(stream))
      dispatchFollow({ type: "scroll-up-intent" });
  };

  /** A wheel from outside the stream (the dock) scrolls it like its own. */
  const scrollByWheel = (event: WheelEvent) => {
    const stream = streamRef.current;
    if (!stream || !event.deltaY) return;
    noteUserIntent();
    if (event.deltaY < 0) noteScrollUpIntent();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? rowHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? stream.clientHeight
          : 1;
    stream.scrollTop += event.deltaY * unit;
  };

  const setPointerHeld = (held: boolean) => {
    pointerHeld.current = held;
  };

  const handleStreamScroll = () => {
    const stream = streamRef.current;
    if (!stream) return;
    measureContentBelow();
    const now = performance.now();
    const source = classifyBlockScroll({
      scrollTop: stream.scrollTop,
      programmaticScrollTop: programmaticScrollTop.current,
      lastUserIntentAt: pointerHeld.current ? now : lastUserIntentAt.current,
      now,
    });
    if (source === "programmatic") {
      programmaticScrollTop.current = undefined;
      return;
    }
    if (source === "user") {
      dispatchFollow({
        type: "user-scroll",
        atBottom: isBlockScrolledToBottom(stream),
      });
    }
  };

  return {
    follow,
    unseen: unseenBlockLineCount(follow, lineFeeds.current),
    contentBelow,
    dispatchFollow,
    scrollStreamTo,
    stickToBottom,
    recordProgrammaticScroll,
    noteUserIntent,
    noteScrollUpIntent,
    setPointerHeld,
    handleStreamScroll,
    scrollByWheel,
  };
};
