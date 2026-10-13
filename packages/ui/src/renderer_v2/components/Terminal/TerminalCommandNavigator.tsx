import React from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CircleAlert,
  CircleHelp,
  ListFilter,
  Radio,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  createImeCompositionTracker,
  disposeImeCompositionTracker,
  isNativeImeKeyEvent,
  markImeCompositionEnd,
  markImeCompositionStart,
  shouldSuppressPostCompositionEnter,
} from "../../lib/imeComposition";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import { SessionGlyph } from "../Common/SessionGlyph";
import { blockStatusLabel } from "./block/blockLabels";
import type { TerminalCommandAnnotation } from "./block/terminalBlockModel";
import {
  filterTerminalCommands,
  getTerminalCommandSearchHighlights,
} from "./terminalCommandNavigation";
import "./terminalCommandNavigator.scss";

export interface TerminalCommandNavigatorLabels {
  title: string;
  search: string;
  empty: string;
  issues: string;
  all: string;
  close: string;
  running: string;
  agent: string;
  user: string;
  succeeded: string;
  failed: string;
  aborted: string;
  unknown: string;
  command: string;
  exitCode: (code: number) => string;
}

/** Popover size before it is fitted to the viewport. */
const POPOVER_WIDTH_PX = 360;
const POPOVER_MAX_HEIGHT_PX = 300;

interface PopoverPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface Props {
  annotations: readonly TerminalCommandAnnotation[];
  labels: TerminalCommandNavigatorLabels;
  selectedId?: string;
  disabled?: boolean;
  onNavigate: (activityId: string) => void;
}

/**
 * Classic footer command finder. The popover is portalled to the body and
 * placed above (or below) the trigger, right-aligned, within the viewport.
 */

export const TerminalCommandNavigator: React.FC<Props> = ({
  annotations,
  labels,
  selectedId,
  disabled = false,
  onNavigate,
}) => {
  const id = React.useId();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const resultsRef = React.useRef<HTMLDivElement>(null);
  const compositionRef = React.useRef(createImeCompositionTracker());
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [issuesOnly, setIssuesOnly] = React.useState(false);
  const [highlightedId, setHighlightedId] = React.useState<string>();
  const [placement, setPlacement] = React.useState<PopoverPlacement>();
  const matches = React.useMemo(
    () => filterTerminalCommands(annotations, query, issuesOnly),
    [annotations, query, issuesOnly],
  );
  const ordinals = React.useMemo(
    () =>
      new Map(
        annotations.map((annotation, index) => [annotation.id, index + 1]),
      ),
    [annotations],
  );
  const highlightedIndex = Math.max(
    0,
    matches.findIndex((annotation) => annotation.id === highlightedId),
  );
  const activeId = matches[highlightedIndex]?.id;
  const highlight = (text: string): React.ReactNode =>
    getTerminalCommandSearchHighlights(text, query).map((segment, index) =>
      segment.match ? <mark key={index}>{segment.text}</mark> : segment.text,
    );

  const isInside = React.useCallback(
    (target: EventTarget | null): boolean =>
      target instanceof Node &&
      Boolean(
        rootRef.current?.contains(target) ||
          popoverRef.current?.contains(target),
      ),
    [],
  );

  const close = React.useCallback((returnFocus = true) => {
    setOpen(false);
    setPlacement(undefined);
    disposeImeCompositionTracker(compositionRef.current);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const navigate = (activityId: string): void => {
    setHighlightedId(activityId);
    close();
    onNavigate(activityId);
  };

  React.useEffect(() => {
    if (!open) return;
    searchRef.current?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !isInside(event.target)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close, isInside]);

  React.useEffect(() => {
    if (disabled) close(false);
  }, [disabled, close]);

  React.useEffect(
    () => () => disposeImeCompositionTracker(compositionRef.current),
    [],
  );

  const place = React.useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const anchor = trigger.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH_PX, window.innerWidth);
    const result = resolveFloatingMenuPlacement({
      // Right-aligned: the menu's right edge meets the trigger's.
      anchorRect: {
        left: anchor.right - width,
        top: anchor.top,
        width,
        height: anchor.height,
      },
      menuWidth: width,
      menuHeight: popover.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      preferredMaxHeight: POPOVER_MAX_HEIGHT_PX,
    });
    setPlacement({
      top: result.top,
      left: result.left,
      width: Math.min(width, result.maxWidth),
      maxHeight: result.maxHeight,
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place, matches.length]);

  React.useLayoutEffect(() => {
    if (!open || !activeId) return;
    const result = resultsRef.current?.querySelector<HTMLElement>(
      "[aria-selected='true']",
    );
    result?.scrollIntoView({ block: "nearest" });
  }, [open, activeId]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Commands are navigation targets, never input sent to the terminal.
    event.stopPropagation();
    if (compositionRef.current.isComposing || isNativeImeKeyEvent(event))
      return;
    if (shouldSuppressPostCompositionEnter(compositionRef.current, event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const index = Math.max(
        0,
        Math.min(matches.length - 1, highlightedIndex + direction),
      );
      setHighlightedId(matches[index]?.id);
      searchRef.current?.focus({ preventScroll: true });
    } else if (
      event.key === "Enter" &&
      event.target === searchRef.current &&
      activeId
    ) {
      event.preventDefault();
      navigate(activeId);
    }
  };

  return (
    <div
      className="terminal-command-navigator"
      ref={rootRef}
      onBlur={(event) => {
        // Blur bubbles here from the portalled popover too (React tree).
        if (
          event.relatedTarget instanceof Node &&
          !isInside(event.relatedTarget)
        ) {
          close(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="terminal-command-navigator-trigger"
        title={labels.title}
        aria-label={labels.title}
        aria-expanded={open}
        aria-controls={open ? `${id}-dialog` : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          if (open) {
            close();
          } else {
            setHighlightedId(selectedId || highlightedId);
            setOpen(true);
          }
        }}
      >
        <ListFilter size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
        <section
          ref={popoverRef}
          id={`${id}-dialog`}
          className="terminal-command-navigator-popover"
          role="dialog"
          aria-label={labels.title}
          style={
            placement
              ? placement
              : { visibility: "hidden", width: POPOVER_WIDTH_PX }
          }
          onKeyDown={onKeyDown}
        >
          <header className="terminal-command-navigator-search">
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              type="search"
              spellCheck={false}
              autoComplete="off"
              role="combobox"
              aria-label={labels.search}
              aria-controls={`${id}-results`}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={
                activeId ? `${id}-option-${highlightedIndex}` : undefined
              }
              placeholder={labels.search}
              onCompositionStart={() =>
                markImeCompositionStart(compositionRef.current)
              }
              onCompositionEnd={() =>
                markImeCompositionEnd(compositionRef.current)
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlightedId(undefined);
              }}
            />
            <span
              className="terminal-command-navigator-count"
              aria-live="polite"
            >
              {matches.length}
            </span>
            <button
              type="button"
              className="terminal-command-navigator-icon"
              title={issuesOnly ? labels.all : labels.issues}
              aria-label={labels.issues}
              aria-pressed={issuesOnly}
              onClick={() => {
                setIssuesOnly((current) => !current);
                setHighlightedId(undefined);
                searchRef.current?.focus({ preventScroll: true });
              }}
            >
              <CircleAlert size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="terminal-command-navigator-icon"
              title={labels.close}
              aria-label={labels.close}
              onClick={() => close()}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </header>
          <div
            ref={resultsRef}
            id={`${id}-results`}
            className="terminal-command-navigator-results"
            role="listbox"
            aria-label={issuesOnly ? labels.issues : labels.all}
          >
            {matches.map((annotation, index) => {
              const { activity } = annotation;
              const source = activity.command || annotation.bufferPreview;
              const title = activity.intent || source || labels.command;
              const actor =
                activity.actor === "agent" ? labels.agent : labels.user;
              const Status =
                activity.status === "running"
                  ? Radio
                  : activity.status === "succeeded"
                    ? Check
                    : activity.status === "outcome-unknown"
                      ? CircleHelp
                      : activity.status === "aborted"
                        ? X
                        : CircleAlert;
              const status = blockStatusLabel(activity.status, labels);
              return (
                <button
                  key={annotation.id}
                  id={`${id}-option-${index}`}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={annotation.id === activeId}
                  aria-label={`${actor}: ${title}, ${status}`}
                  className={`terminal-command-navigator-result is-${activity.actor} is-${activity.status}${activity.intent && source ? " has-source" : ""}`}
                  title={`${actor}: ${source || title}\n${status}${activity.exitCode === undefined ? "" : ` (${labels.exitCode(activity.exitCode)})`}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => navigate(annotation.id)}
                >
                  <span
                    className="terminal-command-navigator-origin"
                    title={actor}
                  >
                    {activity.actor === "agent" ? (
                      <SessionGlyph sessionId={activity.sessionId} size={13} />
                    ) : (
                      <SquareTerminal
                        size={12}
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    )}
                  </span>
                  <span className="terminal-command-navigator-command">
                    <span className="terminal-command-navigator-command-title">
                      {highlight(title)}
                    </span>
                    {activity.intent && source && (
                      <span className="terminal-command-navigator-command-source">
                        {highlight(source)}
                      </span>
                    )}
                  </span>
                  <span
                    className="terminal-command-navigator-status"
                    title={status}
                  >
                    <Status size={12} aria-hidden="true" />
                    {activity.status !== "running" &&
                      activity.exitCode !== undefined &&
                      activity.exitCode !== 0 && (
                        <span>{activity.exitCode}</span>
                      )}
                  </span>
                  <span
                    className="terminal-command-navigator-ordinal"
                    aria-hidden="true"
                  >
                    #{ordinals.get(annotation.id)}
                  </span>
                </button>
              );
            })}
          </div>
          {matches.length === 0 && (
            <div className="terminal-command-navigator-empty">
              {labels.empty}
            </div>
          )}
        </section>,
          document.body,
        )}
    </div>
  );
};
