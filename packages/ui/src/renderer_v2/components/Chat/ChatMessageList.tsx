import React from "react";
import { observer } from "mobx-react-lite";
import type { AppStore } from "../../stores/AppStore";
import type { ChatMessage } from "../../stores/ChatStore";
import { MessageRow } from "./MessageRow";
import { buildChatRenderItems, type ChatRenderItem } from "./chatRenderModel";
import {
  type ChatBannerUiState,
  type ChatBannerUiStateMap,
  getChatBannerUiStateKey,
  mergeChatBannerUiState,
  parseChatBannerUiStateKey,
  pruneChatBannerUiStateForSession,
} from "./chatBannerUiState";
import {
  type ChatOffscreenMeasurementRetentionState,
  buildChatVirtualLayout,
  captureChatViewportAnchor,
  resolveChatAutoScrollOnRender,
  resolveChatOffscreenLayoutChangedItems,
  resolveChatOffscreenStreamingItems,
  resolveNextChatOffscreenMeasurementRetentionState,
  resolveChatDragReleaseScrollTop,
  resolveChatScrollAnchorAdjustment,
  resolveChatVirtualRange,
  resolveChatViewportAnchorScrollTop,
  shouldInvalidateChatMeasuredHeights,
} from "./chatVirtualList";
import type { ChatViewportAnchor } from "./chatVirtualList";
import { useChatResizeAnchor } from "./useChatResizeAnchor";
import { useChatScrollbarDrag } from "./useChatScrollbarDrag";

interface ChatMessageListProps {
  store: AppStore;
  sessionId: string | null;
  isThinking: boolean;
  placeholder: string;
  askLabels: {
    allow: string;
    deny: string;
    allowed: string;
    denied: string;
  };
  onAskDecision: (messageId: string, decision: "allow" | "deny") => void;
  onRollback: (message: ChatMessage) => void;
  onBranch: (message: ChatMessage) => void;
  searchTargetMessageId?: string | null;
  searchTargetVersion?: number;
  searchMatchedMessageIds?: ReadonlySet<string>;
}

interface ObservedChatRowProps {
  itemId: string;
  onHeightChange: (itemId: string, height: number) => void;
  measurementEpoch: number;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}

const BOTTOM_AUTO_SCROLL_THRESHOLD_PX = 50;
const DRAG_BOTTOM_SETTLE_MS = 200;

const ObservedChatRow: React.FC<ObservedChatRowProps> = ({
  itemId,
  onHeightChange,
  measurementEpoch,
  className,
  style,
  children,
}) => {
  const rowRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    const reportHeight = (nextHeight: number) => {
      onHeightChange(itemId, nextHeight);
    };

    reportHeight(element.getBoundingClientRect().height);
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      reportHeight(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [itemId, measurementEpoch, onHeightChange]);

  return (
    <div ref={rowRef} className={className} style={style}>
      {children}
    </div>
  );
};

export const ChatMessageList: React.FC<ChatMessageListProps> = observer(
  ({
    store,
    sessionId,
    isThinking,
    placeholder,
    askLabels,
    onAskDecision,
    onRollback,
    onBranch,
    searchTargetMessageId = null,
    searchTargetVersion = -1,
    searchMatchedMessageIds,
  }) => {
    const scrollRef = React.useRef<HTMLDivElement | null>(null);
    const viewportWidthRef = React.useRef<number | null>(null);
    const rowHeightsRef = React.useRef<Map<string, number>>(new Map());
    const scrollFrameRef = React.useRef<number | null>(null);
    const pendingScrollAdjustmentRef = React.useRef(0);
    const pendingPrependAnchorRef = React.useRef<{
      scrollTop: number;
      scrollHeight: number;
    } | null>(null);
    const resizeAnchor = useChatResizeAnchor();
    const bufferedRowHeightsRef = React.useRef<Map<string, number>>(new Map());
    const postDragBottomFollowRef = React.useRef(false);
    const postDragBottomFollowTimerRef = React.useRef<number | null>(null);
    const resetPostDragBottomFollow = React.useCallback(() => {
      if (postDragBottomFollowTimerRef.current !== null) {
        window.clearTimeout(postDragBottomFollowTimerRef.current);
        postDragBottomFollowTimerRef.current = null;
      }
      postDragBottomFollowRef.current = false;
    }, []);
    const keepPostDragBottomFollowAlive = React.useCallback(() => {
      if (!postDragBottomFollowRef.current) return;
      if (postDragBottomFollowTimerRef.current !== null) {
        window.clearTimeout(postDragBottomFollowTimerRef.current);
      }
      postDragBottomFollowTimerRef.current = window.setTimeout(() => {
        const element = scrollRef.current;
        if (element) {
          element.scrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight,
          );
        }
        postDragBottomFollowRef.current = false;
        postDragBottomFollowTimerRef.current = null;
      }, DRAG_BOTTOM_SETTLE_MS);
    }, []);
    React.useEffect(
      () => resetPostDragBottomFollow,
      [resetPostDragBottomFollow],
    );
    const pendingDragFlushRef = React.useRef<
      | { mode: "bottom" }
      | { mode: "anchor"; anchor: ChatViewportAnchor | null }
      | null
    >(null);
    const scrollbarDrag = useChatScrollbarDrag(
      React.useCallback(() => {
        const element = scrollRef.current;
        const preserveBottom =
          !!element &&
          element.scrollHeight - element.scrollTop - element.clientHeight <=
            BOTTOM_AUTO_SCROLL_THRESHOLD_PX;
        // The final native-thumb scroll can precede the scheduled metric rAF.
        // Read the DOM synchronously so bottom intent outranks a stale anchor.
        const anchor =
          element && !preserveBottom
            ? captureChatViewportAnchor(
                renderItemsRef.current,
                virtualLayoutRef.current,
                element.scrollTop,
              )
            : null;
        const buffered = bufferedRowHeightsRef.current;
        buffered.forEach((height, itemId) => {
          rowHeightsRef.current.set(itemId, height);
        });
        buffered.clear();
        pendingDragFlushRef.current = preserveBottom
          ? { mode: "bottom" }
          : { mode: "anchor", anchor };
        if (preserveBottom) {
          postDragBottomFollowRef.current = true;
          keepPostDragBottomFollowAlive();
        } else {
          resetPostDragBottomFollow();
        }
        setHeightVersion((current) => current + 1);
      }, [keepPostDragBottomFollowAlive, resetPostDragBottomFollow]),
    );
    const renderItemIndexByIdRef = React.useRef<Map<string, number>>(new Map());
    const renderItemsRef = React.useRef<ChatRenderItem[]>([]);
    const lastUserTailAutoScrollMessageIdRef = React.useRef<string | null>(
      null,
    );
    const previousRenderItemsSnapshotRef = React.useRef<{
      sessionId: string | null;
      itemsById: Map<string, ChatRenderItem>;
    }>({
      sessionId: null,
      itemsById: new Map(),
    });
    const virtualLayoutRef = React.useRef<{
      offsets: number[];
      heights: number[];
      totalHeight: number;
    }>({
      offsets: [],
      heights: [],
      totalHeight: 0,
    });
    const shouldAutoScrollRef = React.useRef(true);
    const [heightVersion, setHeightVersion] = React.useState(0);
    const [measurementEpoch, setMeasurementEpoch] = React.useState(0);
    const [scrollTop, setScrollTop] = React.useState(0);
    const [viewportHeight, setViewportHeight] = React.useState(0);
    const [estimateViewportWidth, setEstimateViewportWidth] =
      React.useState<number | null>(null);
    const [, setShouldAutoScroll] = React.useState(true);
    const [bannerUiStateByKey, setBannerUiStateByKey] =
      React.useState<ChatBannerUiStateMap>({});
    const [
      retainedOffscreenMeasurementState,
      setRetainedOffscreenMeasurementState,
    ] = React.useState<ChatOffscreenMeasurementRetentionState>({});

    const session = store.chat.getSessionById(sessionId);
    const renderListVersion = session?.renderListVersion || 0;
    const messageCount = session?.messageIds.length || 0;
    const lastMessageId =
      messageCount > 0 ? session?.messageIds[messageCount - 1] || null : null;
    const lastMessage = lastMessageId
      ? session?.messagesById.get(lastMessageId) || null
      : null;
    const chatDisplayMode = store.chatDisplayMode;
    const lastMessageStreaming = lastMessage?.streaming === true;
    const expandedSeamlessGroupIds = React.useMemo(() => {
      const expandedIds = new Set<string>();
      if (!sessionId) return expandedIds;
      Object.entries(bannerUiStateByKey).forEach(([key, state]) => {
        const parsedKey = parseChatBannerUiStateKey(key);
        if (state.expanded && parsedKey?.sessionId === sessionId) {
          expandedIds.add(parsedKey.messageId);
        }
      });
      return expandedIds;
    }, [bannerUiStateByKey, sessionId]);
    const renderItems = React.useMemo(
      () =>
        buildChatRenderItems(
          session,
          isThinking,
          chatDisplayMode,
          expandedSeamlessGroupIds,
        ),
      // messageCount and lastMessageStreaming ensure recomputation when the
      // session content changes even if renderListVersion is not yet bumped
      // (e.g. during initial auto-restore before hydration completes).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [
        chatDisplayMode,
        expandedSeamlessGroupIds,
        isThinking,
        messageCount,
        lastMessageStreaming,
        renderListVersion,
        session,
        sessionId,
      ],
    );
    renderItemsRef.current = renderItems;
    const previousRenderItemsById =
      previousRenderItemsSnapshotRef.current.sessionId === sessionId
        ? previousRenderItemsSnapshotRef.current.itemsById
        : new Map<string, ChatRenderItem>();
    const renderItemIndexById = React.useMemo(() => {
      const next = new Map<string, number>();
      renderItems.forEach((item, index) => {
        next.set(item.id, index);
      });
      return next;
    }, [renderItems]);

    const handleBannerUiStateChange = React.useCallback(
      (messageId: string, patch: Partial<ChatBannerUiState>) => {
        setBannerUiStateByKey((current) =>
          mergeChatBannerUiState(
            current,
            getChatBannerUiStateKey(sessionId, messageId),
            patch,
          ),
        );
      },
      [sessionId],
    );

    const syncScrollMetrics = React.useCallback(() => {
      const element = scrollRef.current;
      if (!element) return;

      const nextViewportHeight = element.clientHeight;
      const preservePostDragBottom = postDragBottomFollowRef.current;
      if (preservePostDragBottom) {
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - nextViewportHeight,
        );
      }
      const nextScrollTop = element.scrollTop;
      const isAtBottom =
        preservePostDragBottom ||
        element.scrollHeight - nextScrollTop - nextViewportHeight <
          BOTTOM_AUTO_SCROLL_THRESHOLD_PX;

      shouldAutoScrollRef.current = isAtBottom;
      resizeAnchor.rememberStableAnchor(
        isAtBottom
          ? null
          : captureChatViewportAnchor(
              renderItemsRef.current,
              virtualLayoutRef.current,
              nextScrollTop,
            ),
      );
      setScrollTop(nextScrollTop);
      setViewportHeight(nextViewportHeight);
      setShouldAutoScroll(isAtBottom);
    }, [resizeAnchor]);

    const scheduleScrollMetricSync = React.useCallback(() => {
      if (scrollFrameRef.current !== null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        syncScrollMetrics();
      });
    }, [syncScrollMetrics]);

    const handleRowHeightChange = React.useCallback(
      (itemId: string, height: number) => {
        const nextHeight = Math.ceil(height);
        const itemIndex = renderItemIndexByIdRef.current.get(itemId);
        const currentHeight =
          rowHeightsRef.current.get(itemId) ??
          (typeof itemIndex === "number"
            ? virtualLayoutRef.current.heights[itemIndex]
            : undefined);
        if (currentHeight === nextHeight || nextHeight <= 24) {
          return;
        }

        // Applying a measured height mid thumb-drag changes the scroller
        // length, which makes Chromium drop that drag frame. Hold the value
        // until the pointer is released.
        if (scrollbarDrag.isDragging()) {
          bufferedRowHeightsRef.current.set(itemId, nextHeight);
          return;
        }

        if (postDragBottomFollowRef.current) {
          keepPostDragBottomFollowAlive();
        } else if (resizeAnchor.isActive()) {
          resizeAnchor.keepAlive();
        } else if (typeof itemIndex === "number") {
          const element = scrollRef.current;
          const scrollAdjustment = resolveChatScrollAnchorAdjustment({
            layout: virtualLayoutRef.current,
            itemIndex,
            nextHeight,
            scrollTop: element?.scrollTop ?? 0,
            autoScrollEnabled: shouldAutoScrollRef.current,
          });
          if (scrollAdjustment !== 0) {
            pendingScrollAdjustmentRef.current += scrollAdjustment;
          }
        }

        rowHeightsRef.current.set(itemId, nextHeight);
        setHeightVersion((current) => current + 1);
      },
      [keepPostDragBottomFollowAlive, resizeAnchor, scrollbarDrag],
    );

    React.useLayoutEffect(() => {
      shouldAutoScrollRef.current = true;
      setShouldAutoScroll(true);
      setScrollTop(0);
      setViewportHeight(0);
      pendingScrollAdjustmentRef.current = 0;
      resizeAnchor.reset();
      lastUserTailAutoScrollMessageIdRef.current = null;
      rowHeightsRef.current = new Map();
      bufferedRowHeightsRef.current.clear();
      pendingDragFlushRef.current = null;
      resetPostDragBottomFollow();
      setRetainedOffscreenMeasurementState({});
      setMeasurementEpoch((current) => current + 1);
      setHeightVersion((current) => current + 1);
    }, [resetPostDragBottomFollow, resizeAnchor, sessionId]);

    // When display mode changes (e.g. settings load after initial render),
    // item structure changes (classic individual items → seamless groups).
    // Stale measured heights from the old mode cause wrong virtual scroll
    // offsets, so invalidate all measurements to force a fresh layout.
    React.useLayoutEffect(() => {
      resizeAnchor.reset();
      rowHeightsRef.current = new Map();
      bufferedRowHeightsRef.current.clear();
      pendingDragFlushRef.current = null;
      resetPostDragBottomFollow();
      pendingScrollAdjustmentRef.current = 0;
      setMeasurementEpoch((current) => current + 1);
      setHeightVersion((current) => current + 1);
    }, [chatDisplayMode, resetPostDragBottomFollow, resizeAnchor]);

    React.useEffect(() => {
      setBannerUiStateByKey((current) =>
        pruneChatBannerUiStateForSession(
          current,
          sessionId,
          session?.messageIds || [],
        ),
      );
    }, [renderListVersion, sessionId, session]);

    React.useLayoutEffect(() => {
      const element = scrollRef.current;
      if (!element) return;

      const initialViewportWidth = Math.round(element.clientWidth);
      viewportWidthRef.current = initialViewportWidth;
      setEstimateViewportWidth(initialViewportWidth);
      scheduleScrollMetricSync();
      const onScroll = () => {
        // A temporary scrollHeight contraction clamps scrollTop before the next
        // rAF. Correct that clamp in the scroll event itself so no intermediate
        // frame can paint above the tail during post-drag measurement settling.
        if (postDragBottomFollowRef.current) {
          element.scrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight,
          );
        }
        scheduleScrollMetricSync();
        if (!sessionId || !session) return;

        const nearTop = element.scrollTop <= 96;
        if (
          !session.geometryLoaded &&
          nearTop &&
          !shouldAutoScrollRef.current &&
          !resizeAnchor.isActive() &&
          element.scrollHeight > element.clientHeight + 96 &&
          session.hasOlderMessages === true &&
          !session.isLoadingOlderMessages &&
          !pendingPrependAnchorRef.current
        ) {
          pendingPrependAnchorRef.current = {
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
          };
          void store.chat
            .loadOlderMessages(sessionId)
            .then((loaded) => {
              if (!loaded) pendingPrependAnchorRef.current = null;
            })
            .catch((error) => {
              pendingPrependAnchorRef.current = null;
              console.warn("Failed to load older chat messages:", error);
            });
          return;
        }

        const nearBottom =
          element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
        if (
          !session.geometryLoaded &&
          nearBottom &&
          session.hasNewerMessages === true &&
          !session.isLoadingNewerMessages
        ) {
          void store.chat.loadNewerMessages(sessionId).then((loaded) => {
            if (!loaded || !shouldAutoScrollRef.current) return;
            requestAnimationFrame(() => {
              const current = scrollRef.current;
              if (!current) return;
              current.scrollTop = Math.max(
                0,
                current.scrollHeight - current.clientHeight,
              );
              scheduleScrollMetricSync();
            });
          }).catch((error) => {
            console.warn("Failed to load newer chat messages:", error);
          });
        }
      };

      // A press whose target is the scroll container itself lands on the native
      // scrollbar: the track has no child elements, every row is nested deeper.
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        resetPostDragBottomFollow();
        if (event.target !== element) return;
        scrollbarDrag.begin(virtualLayoutRef.current.totalHeight);
      };
      const onWheel = () => {
        resetPostDragBottomFollow();
      };
      // The release can land outside the list, so it is observed on the window.
      const onPointerUp = () => {
        scrollbarDrag.end();
      };

      element.addEventListener("scroll", onScroll, { passive: true });
      element.addEventListener("wheel", onWheel, { passive: true });
      element.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      const resizeObserver =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver((entries) => {
              const nextWidth =
                entries[0]?.contentRect.width ?? element.clientWidth;
              if (
                shouldInvalidateChatMeasuredHeights(
                  viewportWidthRef.current,
                  nextWidth,
                )
              ) {
                if (
                  !shouldAutoScrollRef.current &&
                  !pendingPrependAnchorRef.current
                ) {
                  resizeAnchor.beginResize(
                    captureChatViewportAnchor(
                      renderItemsRef.current,
                      virtualLayoutRef.current,
                      element.scrollTop,
                    ),
                  );
                }
                rowHeightsRef.current = new Map();
                bufferedRowHeightsRef.current.clear();
                pendingDragFlushRef.current = null;
                resetPostDragBottomFollow();
                pendingScrollAdjustmentRef.current = 0;
                setMeasurementEpoch((current) => current + 1);
                setHeightVersion((current) => current + 1);
              }
              const normalizedNextWidth = Math.round(nextWidth);
              viewportWidthRef.current = normalizedNextWidth;
              setEstimateViewportWidth((current) =>
                current === normalizedNextWidth
                  ? current
                  : normalizedNextWidth,
              );
              scheduleScrollMetricSync();
            })
          : null;
      resizeObserver?.observe(element);

      return () => {
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener("wheel", onWheel);
        element.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        resizeObserver?.disconnect();
        if (scrollFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollFrameRef.current);
          scrollFrameRef.current = null;
        }
      };
    }, [
      resetPostDragBottomFollow,
      resizeAnchor,
      scheduleScrollMetricSync,
      scrollbarDrag,
      session,
      sessionId,
      store.chat,
    ]);

    const virtualLayout = React.useMemo(
      () =>
        buildChatVirtualLayout(renderItems, rowHeightsRef.current, {
          viewportWidth: estimateViewportWidth,
        }),
      [estimateViewportWidth, renderItems, heightVersion],
    );
    renderItemIndexByIdRef.current = renderItemIndexById;
    virtualLayoutRef.current = virtualLayout;
    // Growth from streaming or pagination is still allowed to extend the frozen
    // height; only measurement-driven changes are withheld during a drag.
    scrollbarDrag.syncNaturalHeight(virtualLayout.totalHeight);
    const renderedTotalHeight = Math.max(
      virtualLayout.totalHeight,
      scrollbarDrag.frozenTotalHeight() ?? 0,
    );
    const effectiveViewportHeight = viewportHeight > 0 ? viewportHeight : 800;

    const virtualRange = React.useMemo(
      () =>
        resolveChatVirtualRange(
          virtualLayout,
          scrollTop,
          effectiveViewportHeight,
        ),
      [effectiveViewportHeight, scrollTop, virtualLayout],
    );

    React.useEffect(() => {
      if (
        !sessionId ||
        session?.isLoadingInitialHistory ||
        !session?.geometryLoaded ||
        renderItems.length === 0 ||
        typeof store.chat.loadMessageRange !== "function"
      ) {
        return;
      }
      const firstItem = renderItems[virtualRange.startIndex];
      const lastItem =
        renderItems[Math.max(virtualRange.startIndex, virtualRange.endIndex - 1)];
      const firstPosition = firstItem
        ? session.messagePositionById?.get(firstItem.id)
        : undefined;
      const lastPosition = lastItem
        ? session.messagePositionById?.get(lastItem.id)
        : undefined;
      if (typeof firstPosition !== "number" || typeof lastPosition !== "number") {
        return;
      }
      const total = Math.max(0, (session.totalMessageCount || 1) - 1);
      const prefetchPadding = 180;
      const deferredIds = Array.from(
        new Set(
          renderItems
            .slice(virtualRange.startIndex, virtualRange.endIndex)
            .flatMap((item) =>
              item.seamlessGroupMessageIds?.length ? [] : [item.id],
            )
            .map((messageId) => session.messagesById.get(messageId))
            .filter(
              (message): message is ChatMessage =>
                !!message && !!message.deferredPayload?.fields.length,
            )
            .map((message) => message.id),
        ),
      );
      void Promise.all([
        store.chat.loadMessageRange(
          sessionId,
          Math.max(0, firstPosition - prefetchPadding),
          Math.min(total, lastPosition + prefetchPadding),
        ),
        deferredIds.length > 0
          ? store.chat.loadFullMessages(sessionId, deferredIds)
          : Promise.resolve([]),
      ]).catch((error) => {
        console.warn("Failed to load visible chat message range:", error);
      });
    }, [
      renderItems,
      session?.geometryLoaded,
      session?.isLoadingInitialHistory,
      session?.messagePositionById,
      session?.messagesById,
      session?.totalMessageCount,
      sessionId,
      store.chat,
      virtualRange.endIndex,
      virtualRange.startIndex,
    ]);

    React.useLayoutEffect(() => {
      const element = scrollRef.current;
      const dragFlush = pendingDragFlushRef.current;
      if (dragFlush && element) {
        pendingDragFlushRef.current = null;
        const anchoredScrollTop =
          dragFlush.mode === "anchor" && dragFlush.anchor
            ? resolveChatViewportAnchorScrollTop(
                renderItems,
                virtualLayout,
                dragFlush.anchor,
              )
            : null;
        const restoredScrollTop = resolveChatDragReleaseScrollTop({
          preserveBottom: dragFlush.mode === "bottom",
          scrollHeight: element.scrollHeight,
          viewportHeight: element.clientHeight,
          anchoredScrollTop,
        });
        if (restoredScrollTop !== null) {
          element.scrollTop = restoredScrollTop;
          scheduleScrollMetricSync();
        }
        if (dragFlush.mode === "bottom") {
          shouldAutoScrollRef.current = true;
          setShouldAutoScroll(true);
        }
        // Buffered heights land in this commit. Further anchor adjustments
        // would apply the same movement twice.
        resizeAnchor.reset();
        pendingScrollAdjustmentRef.current = 0;
        return;
      }

      if (element && postDragBottomFollowRef.current) {
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        resizeAnchor.reset();
        pendingScrollAdjustmentRef.current = 0;
        scheduleScrollMetricSync();
        return;
      }

      if (element) {
        const anchoredScrollTop = resizeAnchor.resolveScrollTop(
          renderItems,
          virtualLayout,
        );
        if (anchoredScrollTop !== null) {
          element.scrollTop = Math.max(0, anchoredScrollTop);
          scheduleScrollMetricSync();
        }
      }

      const pendingScrollAdjustment = pendingScrollAdjustmentRef.current;
      if (pendingScrollAdjustment !== 0 && element) {
        pendingScrollAdjustmentRef.current = 0;
        element.scrollTop = Math.max(
          0,
          element.scrollTop + pendingScrollAdjustment,
        );
        scheduleScrollMetricSync();
      }

      const prependAnchor = pendingPrependAnchorRef.current;
      if (prependAnchor && element) {
        const heightDelta = element.scrollHeight - prependAnchor.scrollHeight;
        pendingPrependAnchorRef.current = null;
        element.scrollTop = Math.max(0, prependAnchor.scrollTop + heightDelta);
        scheduleScrollMetricSync();
      }
    }, [
      heightVersion,
      messageCount,
      renderItems,
      resizeAnchor,
      scheduleScrollMetricSync,
      session?.loadedStartPosition,
      session?.loadedEndPosition,
      sessionId,
      virtualLayout.totalHeight,
    ]);

    React.useLayoutEffect(() => {
      const element = scrollRef.current;
      if (!element || session?.isLoadingInitialHistory) return;

      const decision = resolveChatAutoScrollOnRender({
        lastMessageId,
        lastMessageRole:
          lastMessage?.role === "user" || lastMessage?.role === "assistant"
            ? lastMessage.role
            : null,
        autoScrollEnabled: shouldAutoScrollRef.current,
        lastUserTailAutoScrollMessageId:
          lastUserTailAutoScrollMessageIdRef.current,
      });
      lastUserTailAutoScrollMessageIdRef.current =
        decision.nextLastUserTailAutoScrollMessageId;

      if (decision.nextAutoScrollEnabled !== shouldAutoScrollRef.current) {
        shouldAutoScrollRef.current = decision.nextAutoScrollEnabled;
        setShouldAutoScroll(decision.nextAutoScrollEnabled);
      }

      if (!decision.shouldScrollToBottom) {
        return;
      }

      element.scrollTop = Math.max(
        0,
        renderedTotalHeight - element.clientHeight,
      );
      scheduleScrollMetricSync();
    }, [
      lastMessageId,
      lastMessage?.role,
      messageCount,
      renderedTotalHeight,
      scheduleScrollMetricSync,
      session?.isLoadingInitialHistory,
      sessionId,
    ]);

    React.useLayoutEffect(() => {
      if (!searchTargetMessageId) {
        return;
      }
      const element = scrollRef.current;
      if (!element) {
        return;
      }
      const targetIndex = renderItemIndexById.get(searchTargetMessageId);
      if (typeof targetIndex !== "number") {
        return;
      }
      const targetTop = virtualLayout.offsets[targetIndex] || 0;
      const targetHeight = virtualLayout.heights[targetIndex] || 120;
      const nextScrollTop = Math.max(
        0,
        targetTop - Math.max(0, (element.clientHeight - targetHeight) / 2),
      );
      element.scrollTop = nextScrollTop;
      scheduleScrollMetricSync();
    }, [
      renderItemIndexById,
      scheduleScrollMetricSync,
      searchTargetMessageId,
      searchTargetVersion,
      virtualLayout.heights,
      virtualLayout.offsets,
    ]);

    const visibleItems = renderItems.slice(
      virtualRange.startIndex,
      virtualRange.endIndex,
    );
    const tailRetentionItemId =
      isThinking && renderItems.length > 0
        ? renderItems[renderItems.length - 1]?.id || null
        : null;
    const streamingRenderItems = React.useMemo(
      () =>
        renderItems.reduce<Array<{ item: ChatRenderItem; index: number }>>(
          (result, item, index) => {
            const isStreaming =
              item.seamlessGroupStreaming === true ||
              session?.messagesById.get(item.id)?.streaming === true;
            if (isStreaming) {
              result.push({ item, index });
            }
            return result;
          },
          [],
        ),
      [renderItems, session],
    );
    const offscreenStreamingItems = React.useMemo(
      () =>
        resolveChatOffscreenStreamingItems(streamingRenderItems, virtualRange),
      [streamingRenderItems, virtualRange.endIndex, virtualRange.startIndex],
    );
    const offscreenLayoutChangedItems = React.useMemo(
      () =>
        resolveChatOffscreenLayoutChangedItems(
          renderItems,
          previousRenderItemsById,
          virtualRange,
        ),
      [
        previousRenderItemsById,
        renderItems,
        virtualRange.endIndex,
        virtualRange.startIndex,
      ],
    );
    const retainedOffscreenItems = React.useMemo(
      () =>
        Object.keys(retainedOffscreenMeasurementState).reduce<ChatRenderItem[]>(
          (result, itemId) => {
            const itemIndex = renderItemIndexById.get(itemId);
            const isVisible =
              typeof itemIndex === "number" &&
              itemIndex >= virtualRange.startIndex &&
              itemIndex < virtualRange.endIndex;
            if (typeof itemIndex !== "number" || isVisible) {
              return result;
            }

            const item = renderItems[itemIndex];
            if (!item) {
              return result;
            }

            result.push(item);
            return result;
          },
          [],
        ),
      [
        renderItemIndexById,
        renderItems,
        retainedOffscreenMeasurementState,
        virtualRange.endIndex,
        virtualRange.startIndex,
      ],
    );
    const offscreenMeasuredItems = React.useMemo(() => {
      const byId = new Map<string, ChatRenderItem>();
      offscreenStreamingItems.forEach((item) => {
        byId.set(item.id, item);
      });
      offscreenLayoutChangedItems.forEach((item) => {
        if (!byId.has(item.id)) {
          byId.set(item.id, item);
        }
      });
      retainedOffscreenItems.forEach((item) => {
        if (!byId.has(item.id)) {
          byId.set(item.id, item);
        }
      });
      return Array.from(byId.values());
    }, [
      offscreenLayoutChangedItems,
      offscreenStreamingItems,
      retainedOffscreenItems,
    ]);

    React.useLayoutEffect(() => {
      previousRenderItemsSnapshotRef.current = {
        sessionId,
        itemsById: new Map(renderItems.map((item) => [item.id, item])),
      };
    }, [renderItems, sessionId]);

    React.useLayoutEffect(() => {
      setRetainedOffscreenMeasurementState((currentState) =>
        resolveNextChatOffscreenMeasurementRetentionState({
          currentState,
          currentOffscreenStreamingItems: offscreenStreamingItems,
          renderItemIndexById,
          visibleRange: virtualRange,
          tailRetentionItemId,
          thinking: isThinking,
        }),
      );
    }, [
      isThinking,
      offscreenStreamingItems,
      renderItemIndexById,
      tailRetentionItemId,
      virtualRange,
    ]);

    return (
      <div className="panel-body" ref={scrollRef}>
        {session?.isLoadingInitialHistory ? (
          <div
            className="message-list message-list-empty message-list-loading"
            role="status"
            aria-label="Loading conversation"
          >
            <span className="message-list-loading-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : messageCount === 0 ? (
          <div className="message-list message-list-empty">
            <div className="placeholder">{placeholder}</div>
          </div>
        ) : (
          <div
            className="message-list message-list-virtual"
            style={{ height: renderedTotalHeight }}
          >
            {visibleItems.map((item, index) => {
              const itemIndex = virtualRange.startIndex + index;
              const bannerUiStateKey =
                getChatBannerUiStateKey(sessionId, item.id) || "";
              return (
                <ObservedChatRow
                  key={item.id}
                  itemId={item.id}
                  onHeightChange={handleRowHeightChange}
                  measurementEpoch={measurementEpoch}
                  className="message-list-row-shell"
                  style={{
                    position: "absolute",
                    top: virtualLayout.offsets[itemIndex] || 0,
                    left: 0,
                    right: 0,
                  }}
                >
                  <MessageRow
                    store={store}
                    sessionId={sessionId || ""}
                    messageId={item.id}
                    onAskDecision={onAskDecision}
                    onRollback={onRollback}
                    onBranch={onBranch}
                    askLabels={askLabels}
                    isThinking={isThinking}
                    mergeWithPreviousAssistant={item.mergeWithPreviousAssistant}
                    showAssistantRoleLabel={item.showAssistantRoleLabel}
                    showAssistantGroupCopy={item.showAssistantGroupCopy}
                    assistantGroupMessageIds={item.assistantGroupMessageIds}
                    assistantGroupBranchMessageId={item.assistantGroupBranchMessageId}
                    seamlessGroupMessageIds={item.seamlessGroupMessageIds}
                    bannerUiState={bannerUiStateByKey[bannerUiStateKey]}
                    onBannerUiStateChange={(patch) =>
                      handleBannerUiStateChange(item.id, patch)
                    }
                    isSearchMatch={
                      searchMatchedMessageIds?.has(item.id) === true
                    }
                    isActiveSearchMatch={searchTargetMessageId === item.id}
                  />
                </ObservedChatRow>
              );
            })}
          </div>
        )}
        {offscreenMeasuredItems.length > 0 && (
          <div
            aria-hidden="true"
            style={{
              height: 0,
              overflow: "hidden",
              pointerEvents: "none",
              visibility: "hidden",
            }}
          >
            {offscreenMeasuredItems.map((item) => {
              const bannerUiStateKey =
                getChatBannerUiStateKey(sessionId, item.id) || "";
              return (
                <ObservedChatRow
                  key={`${item.id}:measurement`}
                  itemId={item.id}
                  onHeightChange={handleRowHeightChange}
                  measurementEpoch={measurementEpoch}
                >
                  <MessageRow
                    store={store}
                    sessionId={sessionId || ""}
                    messageId={item.id}
                    onAskDecision={onAskDecision}
                    onRollback={onRollback}
                    onBranch={onBranch}
                    askLabels={askLabels}
                    isThinking={isThinking}
                    mergeWithPreviousAssistant={item.mergeWithPreviousAssistant}
                    showAssistantRoleLabel={item.showAssistantRoleLabel}
                    showAssistantGroupCopy={item.showAssistantGroupCopy}
                    assistantGroupMessageIds={item.assistantGroupMessageIds}
                    assistantGroupBranchMessageId={item.assistantGroupBranchMessageId}
                    seamlessGroupMessageIds={item.seamlessGroupMessageIds}
                    bannerUiState={bannerUiStateByKey[bannerUiStateKey]}
                    onBannerUiStateChange={(patch) =>
                      handleBannerUiStateChange(item.id, patch)
                    }
                  />
                </ObservedChatRow>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
