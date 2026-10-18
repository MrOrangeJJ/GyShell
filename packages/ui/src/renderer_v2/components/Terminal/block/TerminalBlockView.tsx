import React from "react";
import { ArrowDown, SquareTerminal, Terminal as TerminalIcon } from "lucide-react";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { TerminalViewMode } from "../../../lib/ipcTypes";
import {
  cleanTerminalSessionTitle,
  normalizeTerminalSessionTitle,
} from "../../../lib/sessionTitleDisplay";
import { copyTextToClipboard } from "../../Common/useCopyFeedback";
import { getNavigableTerminalAnnotations } from "../terminalCommandNavigation";
import {
  useTerminalRowHeight,
  type TerminalFontOptions,
} from "../terminalFontOptions";
import { resolveBlockRevealScrollTop } from "../terminalReveal";
import {
  TERMINAL_REVEAL_FLASH_MS,
  TERMINAL_VIEW_TRANSITION_MS,
} from "../terminalViewChrome";
import {
  TerminalViewSwitch,
  type TerminalViewModeLabels,
} from "../TerminalViewSwitch";
import type { TerminalBlockLabels } from "./blockLabels";
import { isBlockScrollKey, isBlockScrollUpKey } from "./blockFollow";
import {
  moveRovingId,
  reduceBlockFocus,
  resolveBlockDetailsPlacement,
  resolveBlockDetailsWidth,
  resolveRovingId,
} from "./blockLayout";
import { resolveBlockRange, type BlockRange } from "./blockRange";
import { BlockDetails } from "./BlockDetails";
import { BlockItem } from "./BlockItem";
import {
  getTerminalBlockLineCount,
  type TerminalCommandAnnotation,
} from "./terminalBlockModel";
import { useBlockStreamFollow } from "./useBlockStreamFollow";
import { useTerminalBlockRevision } from "./useTerminalBlockRevision";
import type { TerminalDockSource } from "./useTerminalBlockDock";
import {
  EMPTY_TERMINAL_DOCK_STATE,
  resolveListedBlockEnd,
} from "./terminalDockModel";
import "./terminalBlock.scss";

/**
 * Block view: one vertical stream of command blocks above the docked prompt
 * (the real xterm, see useTerminalBlockDock), newest at the bottom.
 *
 * Output is plain text in the terminal's own font, row pitch and colours, so a
 * block reads exactly like the prompt below it. Selection is state, not DOM
 * focus, so the prompt keeps the keyboard; printable keys typed while the
 * view has focus go to the prompt. Jumps between views land with context and
 * a one-off accent flash: Terminal -> Block selects the block, places it a
 * little below the top and flashes it; "View in Terminal" lands the command
 * row near the top (terminalReveal.ts). Alternate-screen apps fall back to
 * the native xterm with a badge.
 */

interface Props {
  terminal: Terminal;
  annotations: readonly TerminalCommandAnnotation[];
  theme: ITheme;
  font: TerminalFontOptions;
  labels: TerminalBlockLabels;
  viewModeLabels: TerminalViewModeLabels;
  isActive: boolean;
  visible: boolean;
  focusRequest?: { activityId: string; revision: number };
  onNativeModeChange: (native: boolean) => void;
  onSelectionChange?: (text: string) => void;
  copyOnSelect?: boolean;
  /** Right-click without a selection pastes into the prompt. */
  rightClickToPaste?: boolean;
  onViewModeChange?: (mode: TerminalViewMode) => void;
  /** Replaces the command count while the session is connecting or has ended. */
  footerStatus?: React.ReactNode;
  /** Session not usable yet / any more; the empty state says so. */
  sessionState?: "connecting" | "disconnected";
  sessionTitleLookup?: (sessionId: string) => string | undefined;
  commandSessionTitleLookup?: (sessionId: string) => string | undefined;
  /** The docked prompt (real xterm) below the stream: its height, first line
   *  and wheel. Absent: no dock. */
  dock?: TerminalDockSource;
  onRevealInTerminal?: (activityId: string) => void;
  onSelectActivity?: (activityId: string) => void;
}

/** A jump's selection survives the dock focusing itself for this long. */
const JUMP_FOCUS_GUARD_MS = 600;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Delay until a layout transition has finished (0 with reduced motion). */
const transitionDelay = (extra: number): number =>
  prefersReducedMotion() ? 0 : TERMINAL_VIEW_TRANSITION_MS + extra;

const subscribeToNothing = () => () => undefined;
const getEmptyDockState = () => EMPTY_TERMINAL_DOCK_STATE;

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement);

const hasTextSelection = (): boolean => {
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
};

/** Scrolls `element` into the stream viewport without touching ancestors. */
const revealInScroller = (
  scroller: HTMLElement,
  element: HTMLElement,
): void => {
  const outer = scroller.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  const margin = 4;
  if (inner.top < outer.top) {
    scroller.scrollTop += inner.top - outer.top - margin;
  } else if (inner.bottom > outer.bottom) {
    scroller.scrollTop += Math.min(
      inner.bottom - outer.bottom + margin,
      inner.top - outer.top - margin,
    );
  }
};

export const TerminalBlockView: React.FC<Props> = ({
  terminal,
  annotations,
  theme,
  font,
  labels,
  viewModeLabels,
  isActive,
  visible,
  focusRequest,
  onNativeModeChange,
  onSelectionChange,
  copyOnSelect = false,
  rightClickToPaste = false,
  onViewModeChange,
  sessionTitleLookup,
  commandSessionTitleLookup,
  dock,
  onRevealInTerminal,
  onSelectActivity,
  footerStatus,
  sessionState,
}) => {
  const native = terminal.buffer.active.type === "alternate";
  const listening = isActive && visible;
  const revision = useTerminalBlockRevision(terminal, listening);
  const rowHeight = useTerminalRowHeight(terminal);
  const [focus, dispatchFocus] = React.useReducer(reduceBlockFocus, {});
  const [size, setSize] = React.useState({ width: 0, streamHeight: 0 });
  const boardRef = React.useRef<HTMLDivElement>(null);
  const streamRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLOListElement>(null);
  const detailsPaneRef = React.useRef<HTMLElement>(null);
  const blockElements = React.useRef(new Map<string, HTMLLIElement>());
  const headerElements = React.useRef(new Map<string, HTMLDivElement>());
  const lastHandledFocusRevision = React.useRef<number>(-1);
  /** Until then, the dock taking focus does not close a jump's selection. */
  const jumpFocusGuardUntil = React.useRef(0);
  const pressInBlock = React.useRef(false);
  const [targetedId, setTargetedId] = React.useState<string>();
  // Read at request time; parents may pass a new callback every render.
  const onSelectActivityRef = React.useRef(onSelectActivity);
  onSelectActivityRef.current = onSelectActivity;
  const latestIdRef = React.useRef<string>();
  const {
    follow,
    unseen,
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
  } = useBlockStreamFollow({
    terminal,
    streamRef,
    enabled: listening,
    visible,
    rowHeight,
  });
  // Same frame as the aperture moves, so the stream/dock seam never lags.
  const dockState = React.useSyncExternalStore(
    dock?.subscribe ?? subscribeToNothing,
    dock?.getSnapshot ?? getEmptyDockState,
  );
  const dockHeight = Math.max(0, dockState.height);

  // A wheel over the dock scrolls the stream: one scroll surface.
  const scrollByWheelRef = React.useRef(scrollByWheel);
  scrollByWheelRef.current = scrollByWheel;
  React.useEffect(() => {
    if (!dock || !listening) return undefined;
    dock.setWheelHandler((event) => scrollByWheelRef.current(event));
    return () => dock.setWheelHandler(undefined);
  }, [dock, listening]);

  React.useEffect(
    () => onNativeModeChange(native),
    [native, onNativeModeChange],
  );

  // Clicking into the prompt closes details. The dock also focuses itself
  // when the view opens; that must not undo a jump's selection.
  React.useEffect(() => {
    const textarea = terminal.textarea;
    if (!listening || !textarea) return undefined;
    const release = () => {
      if (performance.now() < jumpFocusGuardUntil.current) return;
      dispatchFocus({ type: "release" });
    };
    textarea.addEventListener("focus", release);
    return () => textarea.removeEventListener("focus", release);
  }, [listening, terminal]);

  const blocks = React.useMemo(
    () => getNavigableTerminalAnnotations(annotations),
    [annotations],
  );
  const blockIds = React.useMemo(() => blocks.map(({ id }) => id), [blocks]);
  const latestId = blockIds[blockIds.length - 1];
  latestIdRef.current = latestId;
  const rovingId = resolveRovingId(blockIds, focus.activeId);

  React.useEffect(() => {
    dispatchFocus({ type: "prune", ids: blockIds });
  }, [blockIds]);

  // The side pane keeps showing the last inspected block while it slides closed.
  const [shownDetailsId, setShownDetailsId] = React.useState<string>();
  React.useEffect(() => {
    if (focus.inspectedId) {
      setShownDetailsId(focus.inspectedId);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setShownDetailsId(undefined),
      transitionDelay(20),
    );
    return () => window.clearTimeout(timer);
  }, [focus.inspectedId]);

  const revealBlock = React.useCallback(
    (id: string) => {
      const stream = streamRef.current;
      const element = blockElements.current.get(id);
      if (!stream || !element) return;
      revealInScroller(stream, element);
      recordProgrammaticScroll();
    },
    [recordProgrammaticScroll],
  );

  // Size changes between renders (expand/details transitions, dock growth).
  React.useEffect(() => {
    const board = boardRef.current;
    const stream = streamRef.current;
    if (!board || !stream) return undefined;
    const observer = new ResizeObserver(() => {
      setSize((current) => {
        const next = {
          width: board.clientWidth,
          streamHeight: stream.clientHeight,
        };
        return current.width === next.width &&
          current.streamHeight === next.streamHeight
          ? current
          : next;
      });
      stickToBottom();
    });
    observer.observe(board);
    observer.observe(stream);
    if (listRef.current) observer.observe(listRef.current);
    return () => observer.disconnect();
  }, [native, visible, blocks.length > 0, stickToBottom]);

  React.useEffect(() => {
    if (detailsPaneRef.current)
      detailsPaneRef.current.inert = !focus.inspectedId;
  });

  const placement = resolveBlockDetailsPlacement(size.width);
  // Split views show full output in the side pane only: a block opened in
  // place before the view widened folds back into the list.
  React.useEffect(() => {
    if (placement === "side" && focus.expandedId) {
      dispatchFocus({ type: "collapse-output", id: focus.expandedId });
    }
  }, [focus.expandedId, placement]);
  const detailsWidth = resolveBlockDetailsWidth(size.width);

  const afterTransition = (callback: () => void) =>
    window.setTimeout(callback, transitionDelay(20));

  const focusStream = () => streamRef.current?.focus({ preventScroll: true });

  const releaseFocus = () => {
    dispatchFocus({ type: "release" });
    focusStream();
  };

  const handleHeaderFocus = (id: string) => {
    // No room for the split pane: the block opens in place instead.
    dispatchFocus({ type: "focus-header", id, expand: placement === "inline" });
    dispatchFollow({ type: "navigate", toLatest: id === latestId });
    onSelectActivity?.(id);
    revealBlock(id);
    if (placement === "inline") afterTransition(() => revealBlock(id));
  };

  const closeBlock = (id: string) => {
    if (focus.inspectedId !== id) return;
    // Closed from its header: keep focus there so Enter reopens it.
    if (document.activeElement === headerElements.current.get(id)) {
      dispatchFocus({ type: "release" });
    } else {
      releaseFocus();
    }
    // Keep the closed block's header where the reader is.
    requestAnimationFrame(() => revealBlock(id));
  };

  const focusHeader = (id: string) => {
    headerElements.current.get(id)?.focus({ preventScroll: true });
  };

  /** One action for the whole block: focus drives inspection. */
  const activateBlock = (id: string) => {
    const header = headerElements.current.get(id);
    if (header && document.activeElement !== header) focusHeader(id);
    else handleHeaderFocus(id);
  };

  /** Only for an opened block whose output exceeds the in-flow cap. */
  const expandBlock = (id: string) => {
    dispatchFocus({ type: "expand-output", id });
    afterTransition(() => revealBlock(id));
  };

  const handleHeaderKeyDown = (id: string, event: React.KeyboardEvent) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = moveRovingId(blockIds, id, event.key === "ArrowUp" ? -1 : 1);
      if (next && next !== id) focusHeader(next);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (focus.inspectedId === id) closeBlock(id);
      else activateBlock(id);
    }
  };

  /** Puts a block's top a little below the stream's top edge. */
  const anchorBlock = React.useCallback(
    (id: string) => {
      const stream = streamRef.current;
      const element = blockElements.current.get(id);
      if (!stream || !element) return;
      const blockTop =
        element.getBoundingClientRect().top -
        stream.getBoundingClientRect().top +
        stream.scrollTop;
      scrollStreamTo(
        resolveBlockRevealScrollTop({
          blockTop,
          viewportHeight: stream.clientHeight,
          maxScrollTop: stream.scrollHeight - stream.clientHeight,
          rowHeight,
        }),
      );
    },
    [rowHeight, scrollStreamTo],
  );

  // A jump from the terminal selects the block, lands it near the top and
  // flashes it once.
  React.useEffect(() => {
    if (
      !visible ||
      !focusRequest?.activityId ||
      focusRequest.revision === lastHandledFocusRevision.current
    ) {
      return undefined;
    }
    lastHandledFocusRevision.current = focusRequest.revision;
    const { activityId } = focusRequest;
    jumpFocusGuardUntil.current = performance.now() + JUMP_FOCUS_GUARD_MS;
    const inline =
      resolveBlockDetailsPlacement(boardRef.current?.clientWidth ?? 0) ===
      "inline";
    dispatchFocus({ type: "focus-header", id: activityId, expand: inline });
    dispatchFollow({
      type: "navigate",
      toLatest: activityId === latestIdRef.current,
    });
    onSelectActivityRef.current?.(activityId);
    setTargetedId(undefined);
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      setTargetedId(activityId);
      anchorBlock(activityId);
      inner = requestAnimationFrame(() => anchorBlock(activityId));
    });
    // The details pane / in-place expansion finishes its transition.
    const settle = window.setTimeout(
      () => anchorBlock(activityId),
      transitionDelay(40),
    );
    const clear = window.setTimeout(
      () => setTargetedId(undefined),
      TERMINAL_REVEAL_FLASH_MS,
    );
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      window.clearTimeout(settle);
      window.clearTimeout(clear);
    };
  }, [anchorBlock, dispatchFollow, focusRequest, visible]);

  const handleBoardKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented || isEditableTarget(event.target)) return;
    if (event.key === "Escape") {
      if (focus.expandedId || focus.inspectedId) {
        event.preventDefault();
        releaseFocus();
      }
      return;
    }
    if (isBlockScrollKey(event.key)) {
      noteUserIntent();
      if (isBlockScrollUpKey(event.key)) noteScrollUpIntent();
      return;
    }
    // Printable keys go to the docked prompt.
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing ||
      hasTextSelection()
    ) {
      return;
    }
    event.preventDefault();
    terminal.focus();
    terminal.input(event.key, true);
  };

  const handleStreamMouseUp = () => {
    const text = window.getSelection()?.toString() || "";
    if (!text) return;
    onSelectionChange?.(text);
    if (copyOnSelect) void copyTextToClipboard(text);
  };

  // Like the terminal's own right-click paste; with a selection the native
  // menu stays available for copying it.
  const handleStreamContextMenu = (event: React.MouseEvent) => {
    if (!rightClickToPaste || hasTextSelection()) return;
    event.preventDefault();
    terminal.focus();
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) terminal.paste(text);
      })
      .catch(() => {
        // Clipboard access refused: nothing to paste.
      });
  };

  const jumpToLatest = () => {
    dispatchFollow({ type: "jump-to-latest" });
    dispatchFocus({ type: "release" });
    terminal.focus();
  };

  if (!visible) return null;
  if (native)
    return (
      <div
        className="terminal-block-view terminal-block-native"
        aria-live="polite"
      >
        <span>
          <SquareTerminal size={13} aria-hidden="true" />
          {labels.alternate}
        </span>
      </div>
    );

  const findBlock = (id?: string) =>
    id ? blocks.find((annotation) => annotation.id === id) : undefined;
  const detailsAnnotation = findBlock(shownDetailsId);
  const detailsSessionTitle =
    detailsAnnotation?.activity.actor === "agent" &&
    detailsAnnotation.activity.sessionId &&
    sessionTitleLookup
      ? normalizeTerminalSessionTitle(
          sessionTitleLookup(detailsAnnotation.activity.sessionId),
        ) || undefined
      : undefined;
  const lineCount = getTerminalBlockLineCount(
    terminal.buffer.normal,
    terminal.cols,
  );
  const ranges = new Map<string, BlockRange>();
  blocks.forEach((annotation, index) => {
    ranges.set(
      annotation.id,
      resolveBlockRange(
        terminal,
        annotation,
        blocks[index + 1]?.startLine ?? lineCount,
        lineCount,
      ),
    );
  });
  const detailsRange = detailsAnnotation
    ? ranges.get(detailsAnnotation.id)
    : undefined;
  const details =
    detailsAnnotation && detailsRange && placement === "side" ? (
      <BlockDetails
        terminal={terminal}
        annotation={detailsAnnotation}
        range={detailsRange}
        theme={theme}
        labels={labels}
        sessionTitle={detailsSessionTitle}
        revision={revision}
        onClose={releaseFocus}
        onRevealInTerminal={onRevealInTerminal}
      />
    ) : null;

  const sideDetailsOpen = placement === "side" && Boolean(focus.inspectedId);

  return (
    <div
      ref={boardRef}
      className={`terminal-block-view${sideDetailsOpen ? " is-split" : ""}`}
      style={
        {
          "--terminal-block-fg": theme.foreground || "var(--fg)",
          "--terminal-block-font-family": font.fontFamily,
          "--terminal-block-font-size": `${font.fontSize}px`,
          "--terminal-block-font-weight": String(font.fontWeight),
          "--terminal-block-font-weight-bold": String(font.fontWeightBold),
          "--terminal-block-row-height": `${rowHeight}px`,
          "--terminal-block-dock-height": `${Math.max(0, dockHeight)}px`,
          "--terminal-block-details-width": `${detailsWidth}px`,
        } as React.CSSProperties
      }
      onKeyDown={handleBoardKeyDown}
    >
      <div
        className={`terminal-block-main${dockHeight > 0 ? " has-dock" : ""}`}
      >
        <div className="terminal-block-stream-column">
          <div
            ref={streamRef}
            className="terminal-block-stream"
            tabIndex={-1}
            aria-label={labels.title}
            onFocus={(event) => {
              // Pressing empty stream space closes details; a press inside
              // a block (reading or selecting its output) does not.
              if (event.target === event.currentTarget && !pressInBlock.current)
                dispatchFocus({ type: "release" });
            }}
            onScroll={handleStreamScroll}
            onWheel={(event) => {
              noteUserIntent();
              if (event.deltaY < 0) noteScrollUpIntent();
            }}
            onTouchStart={noteUserIntent}
            onTouchMove={noteUserIntent}
            onPointerDown={(event) => {
              setPointerHeld(true);
              pressInBlock.current = !!(event.target as HTMLElement).closest(
                ".terminal-block",
              );
              noteUserIntent();
            }}
            onPointerUp={() => {
              setPointerHeld(false);
              pressInBlock.current = false;
            }}
            onPointerCancel={() => setPointerHeld(false)}
            onMouseUp={handleStreamMouseUp}
            onContextMenu={handleStreamContextMenu}
          >
            {blocks.length > 0 ? (
              <ol ref={listRef} className="terminal-block-list">
                {blocks.map((annotation) => {
                  const range = ranges.get(annotation.id)!;
                  const running = annotation.activity.status === "running";
                  const live = annotation.id === latestId || running;
                  const sessionTitle =
                    annotation.activity.sessionId && commandSessionTitleLookup
                      ? cleanTerminalSessionTitle(
                          commandSessionTitleLookup(
                            annotation.activity.sessionId,
                          ),
                        ) || undefined
                      : undefined;
                  return (
                    <BlockItem
                      key={annotation.id}
                      terminal={terminal}
                      annotation={annotation}
                      range={range}
                      theme={theme}
                      labels={labels}
                      sessionTitle={sessionTitle}
                      roving={annotation.id === rovingId}
                      live={live}
                      listedEnd={resolveListedBlockEnd({
                        outputStart: range.outputStart,
                        end: range.end,
                        running,
                        dockTopLine: dockState.topLine,
                      })}
                      version={live ? revision : 0}
                      expanded={annotation.id === focus.expandedId}
                      inspected={annotation.id === focus.inspectedId}
                      targeted={annotation.id === targetedId}
                      placement={placement}
                      registerBlock={(id, element) => {
                        if (element) blockElements.current.set(id, element);
                        else blockElements.current.delete(id);
                      }}
                      registerHeader={(id, element) => {
                        if (element) headerElements.current.set(id, element);
                        else headerElements.current.delete(id);
                      }}
                      onHeaderFocus={handleHeaderFocus}
                      onActivate={activateBlock}
                      onClose={closeBlock}
                      onHeaderKeyDown={handleHeaderKeyDown}
                      onExpand={expandBlock}
                      onRevealInTerminal={onRevealInTerminal}
                    />
                  );
                })}
              </ol>
            ) : (
              <div className="terminal-block-empty">
                <TerminalIcon size={20} strokeWidth={1.5} aria-hidden="true" />
                <span className="terminal-block-empty-title">
                  {labels.emptyTitle}
                </span>
                <span className="terminal-block-empty-desc">
                  {sessionState === "disconnected"
                    ? labels.emptyDisconnected
                    : sessionState === "connecting"
                      ? labels.emptyConnecting
                      : labels.emptyDescription}
                </span>
              </div>
            )}
          </div>
          {!follow.following && unseen > 0 && contentBelow ? (
            <button
              type="button"
              className="terminal-block-jump"
              onClick={jumpToLatest}
            >
              <ArrowDown size={12} aria-hidden="true" />
              <span>
                {labels.newOutput(unseen)} · {labels.follow}
              </span>
            </button>
          ) : null}
        </div>
        {placement === "side" ? (
          <aside
            ref={detailsPaneRef}
            className={`terminal-block-details-pane${sideDetailsOpen ? " is-open" : ""}`}
            aria-label={labels.details}
            aria-hidden={!sideDetailsOpen}
          >
            <div className="terminal-block-details-pane-inner">{details}</div>
          </aside>
        ) : null}
      </div>

      <footer className="terminal-view-toolbar terminal-block-footer">
        {footerStatus ?? (
          <span className="terminal-block-footer-count">
            <span className="terminal-block-footer-dot" aria-hidden="true" />
            <span>
              {labels.title} · {blocks.length}
            </span>
          </span>
        )}
        {onViewModeChange ? (
          <TerminalViewSwitch
            value="block"
            labels={viewModeLabels}
            onChange={onViewModeChange}
          />
        ) : null}
      </footer>
    </div>
  );
};
