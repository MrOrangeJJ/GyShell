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
  pruneChatBannerUiStateForSession,
} from "./chatBannerUiState";
import {
  type ChatOffscreenMeasurementRetentionState,
  buildChatVirtualLayout,
  resolveChatAutoScrollOnRender,
  resolveChatOffscreenLayoutChangedItems,
  resolveChatOffscreenStreamingItems,
  resolveNextChatOffscreenMeasurementRetentionState,
  resolveChatScrollAnchorAdjustment,
  resolveChatVirtualRange,
  shouldInvalidateChatMeasuredHeights,
} from "./chatVirtualList";

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
    const renderItemIndexByIdRef = React.useRef<Map<string, number>>(new Map());
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
      const sessionKeyPrefix = sessionId ? `${sessionId}::` : null;
      if (!sessionKeyPrefix) return expandedIds;
      Object.entries(bannerUiStateByKey).forEach(([key, state]) => {
        if (state.expanded && key.startsWith(sessionKeyPrefix)) {
          expandedIds.add(key.slice(sessionKeyPrefix.length));
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

      const nextScrollTop = element.scrollTop;
      const nextViewportHeight = element.clientHeight;
      const isAtBottom =
        element.scrollHeight - nextScrollTop - nextViewportHeight <
        BOTTOM_AUTO_SCROLL_THRESHOLD_PX;

      shouldAutoScrollRef.current = isAtBottom;
      setScrollTop(nextScrollTop);
      setViewportHeight(nextViewportHeight);
      setShouldAutoScroll(isAtBottom);
    }, []);

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

        if (typeof itemIndex === "number") {
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
      [],
    );

    React.useLayoutEffect(() => {
      shouldAutoScrollRef.current = true;
      setShouldAutoScroll(true);
      setScrollTop(0);
      setViewportHeight(0);
      pendingScrollAdjustmentRef.current = 0;
      lastUserTailAutoScrollMessageIdRef.current = null;
      rowHeightsRef.current = new Map();
      setRetainedOffscreenMeasurementState({});
      setMeasurementEpoch((current) => current + 1);
      setHeightVersion((current) => current + 1);
    }, [sessionId]);

    // When display mode changes (e.g. settings load after initial render),
    // item structure changes (classic individual items → seamless groups).
    // Stale measured heights from the old mode cause wrong virtual scroll
    // offsets, so invalidate all measurements to force a fresh layout.
    React.useLayoutEffect(() => {
      rowHeightsRef.current = new Map();
      pendingScrollAdjustmentRef.current = 0;
      setMeasurementEpoch((current) => current + 1);
      setHeightVersion((current) => current + 1);
    }, [chatDisplayMode]);

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

      viewportWidthRef.current = Math.round(element.clientWidth);
      scheduleScrollMetricSync();
      const onScroll = () => {
        scheduleScrollMetricSync();
      };

      element.addEventListener("scroll", onScroll, { passive: true });
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
                rowHeightsRef.current = new Map();
                pendingScrollAdjustmentRef.current = 0;
                setMeasurementEpoch((current) => current + 1);
                setHeightVersion((current) => current + 1);
              }
              viewportWidthRef.current = Math.round(nextWidth);
              scheduleScrollMetricSync();
            })
          : null;
      resizeObserver?.observe(element);

      return () => {
        element.removeEventListener("scroll", onScroll);
        resizeObserver?.disconnect();
        if (scrollFrameRef.current !== null) {
          window.cancelAnimationFrame(scrollFrameRef.current);
          scrollFrameRef.current = null;
        }
      };
    }, [scheduleScrollMetricSync]);

    const virtualLayout = React.useMemo(
      () => buildChatVirtualLayout(renderItems, rowHeightsRef.current),
      [renderItems, heightVersion],
    );
    renderItemIndexByIdRef.current = renderItemIndexById;
    virtualLayoutRef.current = virtualLayout;
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

    React.useLayoutEffect(() => {
      const pendingScrollAdjustment = pendingScrollAdjustmentRef.current;
      if (pendingScrollAdjustment === 0) {
        return;
      }

      const element = scrollRef.current;
      pendingScrollAdjustmentRef.current = 0;
      if (!element) {
        return;
      }

      element.scrollTop = Math.max(
        0,
        element.scrollTop + pendingScrollAdjustment,
      );
      scheduleScrollMetricSync();
    }, [heightVersion, scheduleScrollMetricSync, sessionId]);

    React.useLayoutEffect(() => {
      const element = scrollRef.current;
      if (!element) return;

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
        virtualLayout.totalHeight - element.clientHeight,
      );
      scheduleScrollMetricSync();
    }, [
      lastMessageId,
      lastMessage?.role,
      messageCount,
      scheduleScrollMetricSync,
      sessionId,
      virtualLayout.totalHeight,
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
        {messageCount === 0 ? (
          <div className="message-list message-list-empty">
            <div className="placeholder">{placeholder}</div>
          </div>
        ) : (
          <div
            className="message-list message-list-virtual"
            style={{ height: virtualLayout.totalHeight }}
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
