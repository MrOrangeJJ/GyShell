import React from "react";
import { toJS } from "mobx";
import { observer } from "mobx-react-lite";
import clsx from "clsx";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { ExternalLink, Trash2 } from "lucide-react";
import type { AppStore } from "../../stores/AppStore";
import {
  MAX_LAYOUT_PANELS,
  computeChildMinSizePercentages,
  determineDropDirection,
  makeLayoutId,
  type LayoutNode,
  type LayoutPanelTabBinding,
  type LayoutRect,
  type LayoutSplitNode,
  type PanelKind,
  type TabDragPayload,
} from "../../layout";
import { ConfirmDialog } from "../Common/ConfirmDialog";
import { renderPanelByKind } from "./panelRenderRegistry";
import { PanelTypeRail } from "./PanelTypeRail";
import type { RailClickIntent, RailPanelKind } from "./panelKindUiRegistry";
import {
  resolveCompactMenuTabReorderHint,
  resolveHorizontalTabBarReorderHint,
} from "./tabDropTargets";
import { getPanelKindAdapter } from "../../stores/panelKindAdapters";
import { canReconnectTerminalRuntime } from "../../lib/terminalConnectionModel";
import {
  WINDOW_CONTEXT,
  buildDetachedLayoutTree,
  clearTabDragState,
  clearPanelDragState,
  createWindowingChannel,
  normalizeWindowingTerminalTabSnapshot,
  openDetachedWindowState,
  readTabDragState,
  readPanelDragState,
  stashTabDragState,
  syncDetachedWindowState,
  stashPanelDragState,
  type DetachedWindowState,
  type WindowingChannel,
  type WindowingDragStartMessage,
  type WindowingPanelDragPayload,
  type WindowingTerminalTabSnapshot,
  type WindowingMessage,
} from "../../lib/windowing";
import {
  normalizeFileEditorSnapshot,
  type FileEditorSnapshot,
} from "../../lib/fileEditorSnapshot";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";

interface LayoutWorkspaceProps {
  store: AppStore;
}

type LayoutMenuMode = "tab" | "bar";

type LayoutMenuAction =
  | "reconnect-terminal"
  | "close-tab"
  | "close-other-tabs"
  | "close-all-tabs"
  | "split-left"
  | "split-right"
  | "split-up"
  | "split-down"
  | "close-panel";

type LayoutMenuLabelKey =
  | "reconnectTab"
  | "closeTab"
  | "closeOtherTabs"
  | "closeAllTabs"
  | "splitLeft"
  | "splitRight"
  | "splitUp"
  | "splitDown"
  | "closePanel";

interface LayoutMenuState {
  panelId: string;
  panelKind: PanelKind;
  mode: LayoutMenuMode;
  targetTabId: string | null;
  x: number;
  y: number;
}

interface PendingTerminalCloseRequest {
  tabIds: string[];
}

interface CrossWindowTabDragPayload extends TabDragPayload {
  sourceClientId: string;
  stateToken?: string;
  terminalTab?: WindowingTerminalTabSnapshot;
}

interface LocalPanelDragPayload {
  panelId: string;
  kind: PanelKind;
}

const isTerminalBackedPanelKind = (kind: PanelKind): boolean =>
  kind === "terminal" || kind === "filesystem" || kind === "monitor";

const toWindowingTerminalTabSnapshot = (
  terminalTab: AppStore["terminalTabs"][number],
): WindowingTerminalTabSnapshot => ({
  id: terminalTab.id,
  title: terminalTab.title,
  config: terminalTab.config,
  ...(terminalTab.connectionRef
    ? { connectionRef: terminalTab.connectionRef }
    : {}),
  ...(terminalTab.runtimeState
    ? { runtimeState: terminalTab.runtimeState }
    : {}),
  ...(typeof terminalTab.lastExitCode === "number"
    ? { lastExitCode: terminalTab.lastExitCode }
    : {}),
});

const collectWindowingTerminalTabSnapshots = (
  store: AppStore,
  tabIds: readonly string[],
): WindowingTerminalTabSnapshot[] | undefined => {
  if (tabIds.length === 0) {
    return undefined;
  }
  const terminalTabById = new Map(
    store.terminalTabs.map((terminalTab) => [terminalTab.id, terminalTab]),
  );
  const seen = new Set<string>();
  const snapshots: WindowingTerminalTabSnapshot[] = [];
  tabIds.forEach((tabId) => {
    const normalizedTabId = String(tabId || "").trim();
    if (!normalizedTabId || seen.has(normalizedTabId)) {
      return;
    }
    seen.add(normalizedTabId);
    const terminalTab = terminalTabById.get(normalizedTabId);
    if (!terminalTab) {
      return;
    }
    snapshots.push(toWindowingTerminalTabSnapshot(terminalTab));
  });
  return snapshots.length > 0 ? snapshots : undefined;
};

const LAYOUT_TAB_DRAG_MIME = "application/x-gyshell-layout-tab";
const LAYOUT_TAB_DRAG_TEXT_PREFIX = "gyshell-tab:";
const LAYOUT_PANEL_DRAG_MIME = "application/x-gyshell-layout-panel";
const LAYOUT_PANEL_DRAG_TEXT_PREFIX = "gyshell-panel:";

const encodeCrossWindowTabDragPayload = (
  payload: CrossWindowTabDragPayload,
): string => JSON.stringify(payload);

const encodeCrossWindowPanelDragPayload = (
  payload: WindowingPanelDragPayload,
): string => JSON.stringify(payload);

const getDragDataByMimeOrTextPrefix = (
  dataTransfer: Pick<DataTransfer, "types" | "getData">,
  mime: string,
  textPrefix: string,
): string | null => {
  const types = Array.from(dataTransfer.types || []);
  if (types.includes(mime)) {
    const raw = dataTransfer.getData(mime);
    if (raw) return raw;
  }
  if (types.includes("text/plain")) {
    const plainText = dataTransfer.getData("text/plain");
    if (plainText.startsWith(textPrefix)) {
      return plainText.slice(textPrefix.length);
    }
  }
  return null;
};

const parseCrossWindowTabDragPayload = (
  dataTransfer: Pick<DataTransfer, "types" | "getData"> | null | undefined,
): CrossWindowTabDragPayload | null => {
  if (!dataTransfer) return null;
  const raw = getDragDataByMimeOrTextPrefix(
    dataTransfer,
    LAYOUT_TAB_DRAG_MIME,
    LAYOUT_TAB_DRAG_TEXT_PREFIX,
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CrossWindowTabDragPayload>;
    const sourceClientId =
      typeof parsed.sourceClientId === "string"
        ? parsed.sourceClientId.trim()
        : "";
    const tabId = typeof parsed.tabId === "string" ? parsed.tabId.trim() : "";
    const sourcePanelId =
      typeof parsed.sourcePanelId === "string"
        ? parsed.sourcePanelId.trim()
        : "";
    const stateToken =
      typeof (parsed as any).stateToken === "string"
        ? (parsed as any).stateToken.trim()
        : "";
    const kind = parsed.kind;
    if (!sourceClientId || !tabId || !sourcePanelId) return null;
    if (
      kind !== "chat" &&
      kind !== "terminal" &&
      kind !== "filesystem" &&
      kind !== "fileEditor" &&
      kind !== "monitor" &&
      kind !== "listPanel"
    ) {
      return null;
    }
    const terminalTab = normalizeWindowingTerminalTabSnapshot(
      (parsed as any).terminalTab,
    );
    return {
      sourceClientId,
      tabId,
      sourcePanelId,
      kind,
      ...(stateToken ? { stateToken } : {}),
      ...(terminalTab ? { terminalTab } : {}),
    };
  } catch {
    return null;
  }
};

const parseCrossWindowPanelDragPayload = (
  dataTransfer: Pick<DataTransfer, "types" | "getData"> | null | undefined,
): WindowingPanelDragPayload | null => {
  if (!dataTransfer) return null;
  const raw = getDragDataByMimeOrTextPrefix(
    dataTransfer,
    LAYOUT_PANEL_DRAG_MIME,
    LAYOUT_PANEL_DRAG_TEXT_PREFIX,
  );
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WindowingPanelDragPayload>;
    const sourceClientId =
      typeof parsed.sourceClientId === "string"
        ? parsed.sourceClientId.trim()
        : "";
    const sourcePanelId =
      typeof parsed.sourcePanelId === "string"
        ? parsed.sourcePanelId.trim()
        : "";
    const stateToken =
      typeof parsed.stateToken === "string" ? parsed.stateToken.trim() : "";
    const kind = parsed.kind;
    if (!sourceClientId || !sourcePanelId) return null;
    if (
      kind !== "chat" &&
      kind !== "terminal" &&
      kind !== "filesystem" &&
      kind !== "fileEditor" &&
      kind !== "monitor" &&
      kind !== "listPanel"
    ) {
      return null;
    }
    const tabBinding = (() => {
      if (!parsed.tabBinding || typeof parsed.tabBinding !== "object") {
        return undefined;
      }
      const rawBinding = parsed.tabBinding as Partial<LayoutPanelTabBinding>;
      const tabIds = Array.isArray(rawBinding.tabIds)
        ? rawBinding.tabIds.filter(
            (tabId): tabId is string =>
              typeof tabId === "string" && tabId.trim().length > 0,
          )
        : [];
      const activeTabId =
        typeof rawBinding.activeTabId === "string" &&
        tabIds.includes(rawBinding.activeTabId)
          ? rawBinding.activeTabId
          : tabIds[0];
      return {
        tabIds,
        ...(activeTabId ? { activeTabId } : {}),
      };
    })();
    const terminalTabs = Array.isArray((parsed as any).terminalTabs)
      ? (parsed as any).terminalTabs
          .map((entry: unknown) => normalizeWindowingTerminalTabSnapshot(entry))
          .filter(
            (
              entry: WindowingTerminalTabSnapshot | undefined,
            ): entry is WindowingTerminalTabSnapshot => !!entry,
          )
      : undefined;
    const fileEditorSnapshot = normalizeFileEditorSnapshot(
      parsed.fileEditorSnapshot,
    );
    return {
      sourceClientId,
      sourcePanelId,
      kind,
      ...(stateToken ? { stateToken } : {}),
      ...(tabBinding ? { tabBinding } : {}),
      ...(terminalTabs && terminalTabs.length > 0 ? { terminalTabs } : {}),
      ...(fileEditorSnapshot ? { fileEditorSnapshot } : {}),
    };
  } catch {
    return null;
  }
};

const resolveExternalPanelDropDirection = (
  rect: LayoutRect,
  clientX: number,
  clientY: number,
): Exclude<ReturnType<typeof determineDropDirection>, null | "center"> => {
  const direction = determineDropDirection(rect, clientX, clientY);
  if (direction && direction !== "center") {
    return direction;
  }
  const distances = [
    { direction: "left" as const, distance: Math.abs(clientX - rect.left) },
    {
      direction: "right" as const,
      distance: Math.abs(rect.left + rect.width - clientX),
    },
    { direction: "top" as const, distance: Math.abs(clientY - rect.top) },
    {
      direction: "bottom" as const,
      distance: Math.abs(rect.top + rect.height - clientY),
    },
  ];
  distances.sort((a, b) => a.distance - b.distance);
  return distances[0]?.direction || "right";
};

const DragOverlay: React.FC<{
  targetRect: LayoutRect | null;
  previewRect: LayoutRect | null;
}> = ({ targetRect, previewRect }) => {
  if (!targetRect && !previewRect) return null;
  return (
    <>
      {targetRect ? (
        <div
          className="gyshell-layout-drop-target-overlay"
          style={{
            left: targetRect.left,
            top: targetRect.top,
            width: targetRect.width,
            height: targetRect.height,
          }}
        />
      ) : null}
      {previewRect ? (
        <div
          className="gyshell-layout-drop-preview-overlay"
          style={{
            left: previewRect.left,
            top: previewRect.top,
            width: previewRect.width,
            height: previewRect.height,
          }}
        />
      ) : null}
    </>
  );
};

const PanelLeaf: React.FC<{
  node: Extract<LayoutNode, { type: "panel" }>;
  store: AppStore;
  onHeaderContextMenu: (
    panelId: string,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void;
  onRequestOpenTabInDetachedWindow: (payload: TabDragPayload) => void;
}> = observer(
  ({
    node,
    store,
    onHeaderContextMenu,
    onRequestCloseTabsByKind,
    onRequestOpenTabInDetachedWindow,
  }) => {
    const panelId = node.panel.id;
    const dragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;
    const isDropTarget =
      store.layout.isDragging && store.layout.dropTargetPanelId === panelId;
    const panelTabIds = store.layout.getPanelTabIds(panelId);

    return (
      <div
        className={clsx("gyshell-layout-leaf", {
          "is-drag-source": dragSource,
          "is-drop-target": isDropTarget,
        })}
        data-layout-panel-id={panelId}
        data-layout-panel-kind={node.panel.kind}
      >
        {renderPanelByKind(node.panel.kind, {
          store,
          panelId,
          tabIds: panelTabIds,
          activeTabId: store.layout.getPanelActiveTabId(panelId),
          onSelectTab: (tabId) =>
            store.layout.setPanelActiveTab(panelId, tabId),
          onRequestCloseTabs: (tabIds) =>
            onRequestCloseTabsByKind(node.panel.kind, tabIds),
          onRequestCloseTabsByKind,
          onRequestOpenTabInDetachedWindow,
          onLayoutHeaderContextMenu: (event) =>
            onHeaderContextMenu(panelId, event),
        })}
      </div>
    );
  },
);

const SplitNodeView: React.FC<{
  node: LayoutSplitNode;
  store: AppStore;
  onHeaderContextMenu: (
    panelId: string,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void;
  onRequestOpenTabInDetachedWindow: (payload: TabDragPayload) => void;
}> = observer(
  ({
    node,
    store,
    onHeaderContextMenu,
    onRequestCloseTabsByKind,
    onRequestOpenTabInDetachedWindow,
  }) => {
    const panelGroupRef = React.useRef<ImperativePanelGroupHandle | null>(null);
    const applyingLayoutRef = React.useRef(true);

    const parentRect = store.layout.geometry.nodeRects[node.id] || {
      left: 0,
      top: 0,
      width: store.layout.viewport.width,
      height: store.layout.viewport.height,
    };

    const minPercentages = computeChildMinSizePercentages(
      node,
      parentRect,
      store.layout.viewport.height,
    ).map((value) => Math.max(0, Math.min(100, value)));

    const sizeSignature = React.useMemo(
      () => node.sizes.map((size) => size.toFixed(3)).join(","),
      [node.sizes],
    );
    const childSignature = React.useMemo(
      () => node.children.map((child) => child.id).join("|"),
      [node.children],
    );

    React.useLayoutEffect(() => {
      const group = panelGroupRef.current;
      applyingLayoutRef.current = true;
      if (group?.setLayout) {
        group.setLayout(node.sizes);
      }
      const frameId = requestAnimationFrame(() => {
        applyingLayoutRef.current = false;
      });
      return () => {
        cancelAnimationFrame(frameId);
      };
    }, [sizeSignature, childSignature]);

    return (
      <PanelGroup
        ref={panelGroupRef}
        direction={node.direction}
        className="gyshell-layout-split"
        onLayout={(sizes) => {
          if (applyingLayoutRef.current) {
            return;
          }
          store.layout.setSplitSizes(node.id, sizes);
        }}
      >
        {node.children.map((child, index) => {
          const defaultSize =
            node.sizes[index] ?? 100 / Math.max(1, node.children.length);
          const minSize = minPercentages[index] ?? 0;
          return (
            <React.Fragment key={child.id}>
              <Panel
                id={child.id}
                order={index}
                defaultSize={defaultSize}
                minSize={minSize}
              >
                <LayoutNodeView
                  node={child}
                  store={store}
                  onHeaderContextMenu={onHeaderContextMenu}
                  onRequestCloseTabsByKind={onRequestCloseTabsByKind}
                  onRequestOpenTabInDetachedWindow={
                    onRequestOpenTabInDetachedWindow
                  }
                />
              </Panel>
              {index < node.children.length - 1 ? (
                <PanelResizeHandle className="gyshell-resize-handle" />
              ) : null}
            </React.Fragment>
          );
        })}
      </PanelGroup>
    );
  },
);

const LayoutNodeView: React.FC<{
  node: LayoutNode;
  store: AppStore;
  onHeaderContextMenu: (
    panelId: string,
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  onRequestCloseTabsByKind: (kind: PanelKind, tabIds: string[]) => void;
  onRequestOpenTabInDetachedWindow: (payload: TabDragPayload) => void;
}> = ({
  node,
  store,
  onHeaderContextMenu,
  onRequestCloseTabsByKind,
  onRequestOpenTabInDetachedWindow,
}) => {
  if (node.type === "panel") {
    return (
      <PanelLeaf
        node={node}
        store={store}
        onHeaderContextMenu={onHeaderContextMenu}
        onRequestCloseTabsByKind={onRequestCloseTabsByKind}
        onRequestOpenTabInDetachedWindow={onRequestOpenTabInDetachedWindow}
      />
    );
  }

  return (
    <SplitNodeView
      node={node}
      store={store}
      onHeaderContextMenu={onHeaderContextMenu}
      onRequestCloseTabsByKind={onRequestCloseTabsByKind}
      onRequestOpenTabInDetachedWindow={onRequestOpenTabInDetachedWindow}
    />
  );
};

const splitActions: Array<{
  action: LayoutMenuAction;
  labelKey: LayoutMenuLabelKey;
  direction: "horizontal" | "vertical";
  position: "before" | "after";
}> = [
  {
    action: "split-up",
    labelKey: "splitUp",
    direction: "vertical",
    position: "before",
  },
  {
    action: "split-down",
    labelKey: "splitDown",
    direction: "vertical",
    position: "after",
  },
  {
    action: "split-left",
    labelKey: "splitLeft",
    direction: "horizontal",
    position: "before",
  },
  {
    action: "split-right",
    labelKey: "splitRight",
    direction: "horizontal",
    position: "after",
  },
];

export const LayoutWorkspace: React.FC<LayoutWorkspaceProps> = observer(
  ({ store }) => {
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const canvasRef = React.useRef<HTMLDivElement | null>(null);
    const menuRef = React.useRef<HTMLDivElement | null>(null);
    const trashRef = React.useRef<HTMLDivElement | null>(null);
    const detachRef = React.useRef<HTMLDivElement | null>(null);
    const isTrashHoverRef = React.useRef(false);
    const isDetachHoverRef = React.useRef(false);
    const externalSourceClientIdRef = React.useRef<string | null>(null);
    const externalPanelDragPayloadRef =
      React.useRef<WindowingPanelDragPayload | null>(null);
    const localTabDragStateTokenRef = React.useRef<string | null>(null);
    const localPanelDragStateTokenRef = React.useRef<string | null>(null);
    const pendingLocalPanelDragRef = React.useRef<LocalPanelDragPayload | null>(
      null,
    );
    const pendingLocalTabDragRef = React.useRef<TabDragPayload | null>(null);
    const pendingNativeDragIntentTargetRef = React.useRef<EventTarget | null>(
      null,
    );
    const pendingNativeDragIntentTimeRef = React.useRef(0);
    const nativeDragStartHandledRef = React.useRef(false);
    const skipDetachedClosingRef = React.useRef(false);
    const detachedStateSyncTimerRef = React.useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const windowingChannelRef = React.useRef<WindowingChannel | null>(null);
    /** Stores cross-window drag payload received from the windowing channel
     *  for when DataTransfer.getData() is restricted during dragover. */
    const crossWindowDragRef = React.useRef<WindowingDragStartMessage | null>(
      null,
    );
    const t = store.i18n.t;

    const [layoutMenu, setLayoutMenu] = React.useState<LayoutMenuState | null>(
      null,
    );
    const [layoutMenuStyle, setLayoutMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const [isTrashHover, setIsTrashHover] = React.useState(false);
    const [isDetachHover, setIsDetachHover] = React.useState(false);
    const [pendingTerminalCloseRequest, setPendingTerminalCloseRequest] =
      React.useState<PendingTerminalCloseRequest | null>(null);
    const [tabInsertIndicatorRect, setTabInsertIndicatorRect] =
      React.useState<LayoutRect | null>(null);

    const recomputeLayoutMenuStyle = React.useCallback(() => {
      const menu = menuRef.current;
      if (!layoutMenu || !menu) return;

      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: layoutMenu.x,
          top: layoutMenu.y,
          width: 0,
          height: 0,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 2,
        preferredMaxHeight: 320,
      });

      setLayoutMenuStyle((current) => {
        if (
          current?.left === placement.left &&
          current?.top === placement.top &&
          current?.maxHeight === placement.maxHeight &&
          current?.maxWidth === placement.maxWidth
        ) {
          return current;
        }
        return {
          left: placement.left,
          top: placement.top,
          maxHeight: placement.maxHeight,
          maxWidth: placement.maxWidth,
        };
      });
    }, [layoutMenu]);

    const setSelectionSuppressed = React.useCallback((suppressed: boolean) => {
      document.body?.classList.toggle(
        "chat-drag-selection-suppressed",
        suppressed,
      );
    }, []);

    const setTrashHover = React.useCallback((value: boolean) => {
      isTrashHoverRef.current = value;
      setIsTrashHover(value);
    }, []);

    const setDetachHover = React.useCallback((value: boolean) => {
      isDetachHoverRef.current = value;
      setIsDetachHover(value);
    }, []);

    const clearTabInsertIndicator = React.useCallback(() => {
      setTabInsertIndicatorRect(null);
    }, []);

    const normalizeClosableTabIds = React.useCallback(
      (kind: PanelKind, tabIds: string[]): string[] => {
        if (!getPanelKindAdapter(kind).supportsTabs || kind === "filesystem") {
          return [];
        }
        const ownerIds =
          kind === "terminal"
            ? new Set(store.terminalTabs.map((tab) => tab.id))
            : new Set(store.chat.sessions.map((session) => session.id));
        const seen = new Set<string>();
        const next: string[] = [];
        tabIds.forEach((tabId) => {
          if (!tabId || seen.has(tabId) || !ownerIds.has(tabId)) return;
          seen.add(tabId);
          next.push(tabId);
        });
        return next;
      },
      [store.chat.sessions, store.terminalTabs],
    );

    const requestCloseTabsByKind = React.useCallback(
      (kind: PanelKind, tabIds: string[]) => {
        if (!getPanelKindAdapter(kind).supportsTabs || kind === "filesystem")
          return;
        const ids = normalizeClosableTabIds(kind, tabIds);
        if (ids.length === 0) return;
        if (kind === "terminal") {
          setPendingTerminalCloseRequest({
            tabIds: ids,
          });
          return;
        }
        ids.forEach((sessionId) => {
          store.chat.closeSession(sessionId);
        });
      },
      [normalizeClosableTabIds, store.chat],
    );

    const requestClosePanel = React.useCallback(
      (panelId: string) => {
        if (!store.layout.canRemovePanel(panelId)) return;
        const panelKind = store.layout.getPanelKindById(panelId);
        if (panelKind && !store.canClosePanel(panelKind)) {
          return;
        }
        store.layout.removePanel(panelId);
        if (panelKind) {
          store.onPanelRemoved(panelKind);
        }
      },
      [store],
    );

    const clearDropPreview = React.useCallback(() => {
      clearTabInsertIndicator();
      store.layout.clearTabReorderTarget();
      store.layout.setDropTarget(null, null);
    }, [clearTabInsertIndicator, store.layout]);

    const clearLocalPanelDragState = React.useCallback(() => {
      // The source window owns the storage-backed panel drag snapshot. Release it
      // on drag-end and after the target confirms panel-moved to avoid stale state.
      const token = localPanelDragStateTokenRef.current;
      if (!token) {
        return;
      }
      clearPanelDragState(token);
      localPanelDragStateTokenRef.current = null;
    }, []);

    const clearLocalTabDragState = React.useCallback(() => {
      const token = localTabDragStateTokenRef.current;
      if (!token) {
        return;
      }
      clearTabDragState(token);
      localTabDragStateTokenRef.current = null;
    }, []);

    const resetDragUi = React.useCallback(
      (options?: { preserveCrossWindowDrag?: boolean }) => {
        setSelectionSuppressed(false);
        setTrashHover(false);
        setDetachHover(false);
        clearTabInsertIndicator();
        externalSourceClientIdRef.current = null;
        externalPanelDragPayloadRef.current = null;
        pendingLocalPanelDragRef.current = null;
        pendingLocalTabDragRef.current = null;
        if (!options?.preserveCrossWindowDrag) {
          crossWindowDragRef.current = null;
        }
        pendingNativeDragIntentTargetRef.current = null;
        pendingNativeDragIntentTimeRef.current = 0;
        nativeDragStartHandledRef.current = false;
      },
      [
        clearTabInsertIndicator,
        setDetachHover,
        setSelectionSuppressed,
        setTrashHover,
      ],
    );

    const rollbackExternalTabDrag = React.useCallback(
      (
        payload: TabDragPayload | null,
        externalSourceClientId: string | null,
      ): void => {
        if (
          !payload ||
          !externalSourceClientId ||
          externalSourceClientId === store.windowClientId
        ) {
          return;
        }
        store.suppressTabs(payload.kind, [payload.tabId], {
          syncLayout: false,
        });
        store.layout.detachTabFromLayout(payload.kind, payload.tabId);
      },
      [store],
    );

    const cancelExternalTabAdoption = React.useCallback(
      (options?: { preserveCrossWindowDrag?: boolean }) => {
        const externalSourceClientId = externalSourceClientIdRef.current;
        const draggingTab = store.layout.draggingTab;
        rollbackExternalTabDrag(draggingTab, externalSourceClientId);
        if (
          externalSourceClientId &&
          externalSourceClientId !== store.windowClientId &&
          store.layout.isDragging &&
          store.layout.dragType === "tab"
        ) {
          store.layout.clearDragging();
        } else {
          clearDropPreview();
        }
        resetDragUi({
          preserveCrossWindowDrag: options?.preserveCrossWindowDrag,
        });
      },
      [
        clearDropPreview,
        resetDragUi,
        rollbackExternalTabDrag,
        store.layout,
        store.windowClientId,
      ],
    );

    const cancelExternalPanelAdoption = React.useCallback(
      (options?: { preserveCrossWindowDrag?: boolean }) => {
        if (
          store.layout.isDragging &&
          store.layout.dragType === "panel" &&
          store.layout.draggingExternalPanelKind
        ) {
          store.layout.clearDragging();
        } else {
          clearDropPreview();
        }
        resetDragUi({
          preserveCrossWindowDrag: options?.preserveCrossWindowDrag,
        });
      },
      [clearDropPreview, resetDragUi, store.layout],
    );

    const postWindowingMessage = React.useCallback(
      (message: WindowingMessage) => {
        const channel = windowingChannelRef.current;
        if (!channel) return;
        try {
          channel.postMessage(message);
        } catch {
          // ignore cross-window broadcast errors
        }
      },
      [],
    );

    const closeDetachedWindowAfterConfirmedTransfer = React.useCallback(
      (kind: PanelKind): boolean => {
        if (!store.isDetachedWindow || store.layout.panelCount !== 1) {
          return false;
        }
        // A detached single-panel workspace is allowed to disappear after another
        // window confirms it adopted the transferred content. Skip the generic
        // detached-closing rollback broadcast so the moved tabs do not bounce back.
        skipDetachedClosingRef.current = true;
        store.onPanelRemoved(kind);
        window.close();
        return true;
      },
      [store],
    );

    const closeDetachedWindowIfSinglePanelBecomesEmpty = React.useCallback(
      (kind: PanelKind): boolean => {
        if (!store.isDetachedWindow || store.layout.panelCount !== 1) {
          return false;
        }
        const remainingPanelId = store.layout.panelNodes[0]?.panel.id;
        if (!remainingPanelId) {
          return false;
        }
        const remainingPanelKind =
          store.layout.getPanelKindById(remainingPanelId);
        if (
          remainingPanelKind !== kind ||
          !getPanelKindAdapter(kind).supportsTabs
        ) {
          return false;
        }
        if (store.layout.getPanelTabIds(remainingPanelId).length > 0) {
          return false;
        }
        return closeDetachedWindowAfterConfirmedTransfer(kind);
      },
      [closeDetachedWindowAfterConfirmedTransfer, store],
    );

    React.useEffect(() => {
      const channel = createWindowingChannel();
      windowingChannelRef.current = channel;
      if (!channel) {
        return () => {
          windowingChannelRef.current = null;
        };
      }

      channel.onmessage = (event: { data: WindowingMessage }) => {
        const payload = event.data;
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "tab-moved") {
          if (payload.sourceClientId !== store.windowClientId) return;
          if (payload.targetClientId === store.windowClientId) return;
          store.suppressTabs(payload.kind, [payload.tabId], {
            syncLayout: false,
          });
          store.layout.detachTabFromLayout(payload.kind, payload.tabId);
          closeDetachedWindowIfSinglePanelBecomesEmpty(payload.kind);
          return;
        }

        if (payload.type === "panel-moved") {
          if (payload.sourceClientId !== store.windowClientId) return;
          if (payload.targetClientId === store.windowClientId) return;
          const sourcePanelKind = store.layout.getPanelKindById(
            payload.sourcePanelId,
          );
          if (sourcePanelKind !== payload.kind) return;

          // The source window can finally release its storage-backed drag snapshot
          // once another window confirms it imported the panel successfully.
          clearLocalPanelDragState();

          if (payload.tabIds.length > 0) {
            store.suppressTabs(payload.kind, payload.tabIds, {
              syncLayout: false,
            });
          }

          if (store.layout.canRemovePanel(payload.sourcePanelId)) {
            store.layout.removePanel(payload.sourcePanelId);
            store.onPanelRemoved(payload.kind);
            return;
          }

          if (closeDetachedWindowAfterConfirmedTransfer(payload.kind)) {
            return;
          }
          return;
        }

        if (payload.type === "detached-closing") {
          if (store.windowRole !== "main") return;
          if (payload.sourceClientId !== store.windowClientId) return;
          const tabsByKind = payload.tabsByKind || {};
          const chatTabIds = store.materializeTransferredTabs(
            "chat",
            tabsByKind.chat || [],
          );
          store.unsuppressTabs("chat", chatTabIds);
          store.hydrateTransferredTabs("chat", chatTabIds);
          store.unsuppressTabs("terminal", tabsByKind.terminal || []);
          store.unsuppressTabs("filesystem", tabsByKind.filesystem || []);
          store.unsuppressTabs("monitor", tabsByKind.monitor || []);
          return;
        }

        if (payload.type === "drag-start") {
          if (payload.sourceClientId === store.windowClientId) return;
          crossWindowDragRef.current = payload;
          return;
        }

        if (payload.type === "drag-end") {
          if (externalSourceClientIdRef.current === payload.sourceClientId) {
            if (
              store.layout.dragType === "panel" &&
              store.layout.draggingExternalPanelKind
            ) {
              cancelExternalPanelAdoption();
            } else {
              cancelExternalTabAdoption();
            }
            return;
          }
          if (
            crossWindowDragRef.current?.sourceClientId ===
            payload.sourceClientId
          ) {
            crossWindowDragRef.current = null;
          }
          return;
        }
      };

      return () => {
        channel.close();
        if (windowingChannelRef.current === channel) {
          windowingChannelRef.current = null;
        }
      };
    }, [
      cancelExternalPanelAdoption,
      cancelExternalTabAdoption,
      clearLocalPanelDragState,
      closeDetachedWindowAfterConfirmedTransfer,
      closeDetachedWindowIfSinglePanelBecomesEmpty,
      store,
    ]);

    React.useEffect(() => {
      const onDetachedWindowCascadeClosing =
        window.gyshell.windowing.onDetachedWindowCascadeClosing;
      if (typeof onDetachedWindowCascadeClosing !== "function") {
        return;
      }
      const unsubscribe = onDetachedWindowCascadeClosing(() => {
        // Main-controlled cascades reclaim ownership centrally, so detached
        // renderers must skip their normal per-window rollback broadcast.
        skipDetachedClosingRef.current = true;
      });
      return () => {
        unsubscribe();
      };
    }, []);

    React.useEffect(() => {
      if (!store.isDetachedWindow) {
        return;
      }
      void window.gyshell.windowing
        .updateTabOwnership(store.collectAssignedTabsByKind())
        .catch(() => {});
    }, [store, store.isDetachedWindow, store.layout.tree]);

    React.useEffect(() => {
      const onActivateTab = window.gyshell.windowing.onActivateTab;
      if (typeof onActivateTab !== "function") {
        return;
      }
      return onActivateTab((target) => {
        const panelId =
          store.layout
            .getPanelIdsByKind(target.kind)
            .find((candidatePanelId) =>
              store.layout
                .getPanelTabIds(candidatePanelId)
                .includes(target.tabId),
            ) || null;
        if (!panelId) {
          return;
        }
        store.layout.setPanelActiveTab(panelId, target.tabId);
        store.layout.setFocusedPanel(panelId);
      });
    }, [store.layout]);

    const syncDetachedWindowSnapshot = React.useCallback(() => {
      if (!store.isDetachedWindow) {
        return;
      }
      const detachedStateToken = String(
        WINDOW_CONTEXT.detachedStateToken || "",
      ).trim();
      const sourceClientId = String(store.detachedSourceClientId || "").trim();
      if (!detachedStateToken || !sourceClientId) {
        return;
      }
      const assignedTabs = store.collectAssignedTabsByKind();
      const terminalTabs = collectWindowingTerminalTabSnapshots(store, [
        ...(assignedTabs.terminal || []),
        ...(assignedTabs.filesystem || []),
        ...(assignedTabs.monitor || []),
      ]);
      const nextState: DetachedWindowState = {
        sourceClientId,
        layoutTree: toJS(store.layout.tree),
        createdAt: Date.now(),
        fileEditorSnapshot: store.fileEditor.captureSnapshot(),
        ...(terminalTabs ? { terminalTabs } : {}),
      };
      syncDetachedWindowState(detachedStateToken, nextState);
    }, [store]);

    React.useEffect(() => {
      if (!store.isDetachedWindow) {
        return;
      }
      if (detachedStateSyncTimerRef.current) {
        clearTimeout(detachedStateSyncTimerRef.current);
        detachedStateSyncTimerRef.current = null;
      }
      detachedStateSyncTimerRef.current = setTimeout(() => {
        detachedStateSyncTimerRef.current = null;
        syncDetachedWindowSnapshot();
      }, 120);
      return () => {
        if (detachedStateSyncTimerRef.current) {
          clearTimeout(detachedStateSyncTimerRef.current);
          detachedStateSyncTimerRef.current = null;
        }
      };
    }, [
      store.detachedSourceClientId,
      store.fileEditor.content,
      store.fileEditor.dirty,
      store.fileEditor.errorMessage,
      store.fileEditor.filePath,
      store.fileEditor.mode,
      store.fileEditor.statusMessage,
      store.fileEditor.terminalId,
      store.isDetachedWindow,
      store.layout.tree,
      syncDetachedWindowSnapshot,
    ]);

    React.useEffect(() => {
      if (!store.isDetachedWindow) return;
      const sourceClientId = String(store.detachedSourceClientId || "").trim();
      if (!sourceClientId) return;

      const notifyDetachedClosing = () => {
        if (detachedStateSyncTimerRef.current) {
          clearTimeout(detachedStateSyncTimerRef.current);
          detachedStateSyncTimerRef.current = null;
        }
        syncDetachedWindowSnapshot();
        if (skipDetachedClosingRef.current) {
          return;
        }
        // Window shutdown stays lightweight on purpose. Dirty file editors only
        // prompt during explicit panel-level removal flows; closing a detached
        // window does not intercept unload to preserve the normal app-exit model.
        postWindowingMessage({
          type: "detached-closing",
          sourceClientId,
          tabsByKind: store.collectAssignedTabsByKind(),
        });
      };

      window.addEventListener("beforeunload", notifyDetachedClosing);
      return () => {
        window.removeEventListener("beforeunload", notifyDetachedClosing);
      };
    }, [postWindowingMessage, store, syncDetachedWindowSnapshot]);

    const toPanelTabBinding = React.useCallback(
      (panelId: string, kind: PanelKind): LayoutPanelTabBinding | undefined => {
        if (!getPanelKindAdapter(kind).supportsTabs) {
          return undefined;
        }
        const tabIds = store.layout.getPanelTabIds(panelId);
        const activeTabId = store.layout.getPanelActiveTabId(panelId);
        return {
          tabIds,
          ...(activeTabId ? { activeTabId } : {}),
        };
      },
      [store.layout],
    );

    const toPanelFileEditorSnapshot = React.useCallback(
      (kind: PanelKind): FileEditorSnapshot | undefined => {
        if (kind !== "fileEditor") {
          return undefined;
        }
        return store.fileEditor.captureSnapshot();
      },
      [store.fileEditor],
    );

    const detachPanelToWindow = React.useCallback(
      async (panelId: string) => {
        if (!store.layout.canRemovePanel(panelId)) return;
        const panelKind = store.layout.getPanelKindById(panelId);
        if (!panelKind) return;
        if (!store.canClosePanel(panelKind)) return;

        const panelBinding = toPanelTabBinding(panelId, panelKind);
        const fileEditorSnapshot = toPanelFileEditorSnapshot(panelKind);
        const terminalTabs =
          panelBinding && isTerminalBackedPanelKind(panelKind)
            ? collectWindowingTerminalTabSnapshots(store, panelBinding.tabIds)
            : undefined;
        const detachedTree = buildDetachedLayoutTree(panelKind, panelBinding);
        const opened = await openDetachedWindowState({
          sourceClientId: store.windowClientId,
          layoutTree: detachedTree,
          createdAt: Date.now(),
          ...(fileEditorSnapshot ? { fileEditorSnapshot } : {}),
          ...(terminalTabs ? { terminalTabs } : {}),
        });
        if (!opened) {
          return;
        }

        const movedTabIds = panelBinding?.tabIds || [];
        store.suppressTabs(panelKind, movedTabIds, { syncLayout: false });
        store.layout.removePanel(panelId);
        store.onPanelRemoved(panelKind);
      },
      [store, toPanelFileEditorSnapshot, toPanelTabBinding],
    );

    const detachTabToWindow = React.useCallback(
      async (payload: TabDragPayload) => {
        if (!getPanelKindAdapter(payload.kind).supportsTabs) return;
        if (
          payload.kind !== "chat" &&
          payload.kind !== "terminal" &&
          payload.kind !== "filesystem" &&
          payload.kind !== "monitor"
        ) {
          return;
        }
        const tabId = String(payload.tabId || "").trim();
        if (!tabId) return;

        const detachedTree = buildDetachedLayoutTree(payload.kind, {
          tabIds: [tabId],
          activeTabId: tabId,
        });
        const terminalTabs = isTerminalBackedPanelKind(payload.kind)
          ? collectWindowingTerminalTabSnapshots(store, [tabId])
          : undefined;
        const opened = await openDetachedWindowState(
          {
            sourceClientId: store.windowClientId,
            layoutTree: detachedTree,
            createdAt: Date.now(),
            ...(terminalTabs ? { terminalTabs } : {}),
          },
          {
            focusTarget: {
              kind: payload.kind,
              tabId,
            },
          },
        );
        if (!opened) {
          return;
        }

        store.suppressTabs(payload.kind, [tabId], { syncLayout: false });
        store.layout.detachTabFromLayout(payload.kind, tabId);
      },
      [store],
    );

    const openKindInDetachedWindow = React.useCallback(
      async (kind: RailPanelKind, intent: RailClickIntent) => {
        const adapter = getPanelKindAdapter(kind);
        const ownerTabIds = adapter.supportsTabs
          ? adapter.getOwnerTabIds(store)
          : [];
        const activeTabId = adapter.supportsTabs
          ? adapter.getGlobalActiveTabId(store)
          : null;
        const tabBinding =
          adapter.supportsTabs &&
          (intent === "open-panel-only" || ownerTabIds.length > 0)
            ? {
                tabIds: ownerTabIds,
                ...(activeTabId && ownerTabIds.includes(activeTabId)
                  ? { activeTabId }
                  : ownerTabIds[0]
                    ? { activeTabId: ownerTabIds[0] }
                    : {}),
              }
            : undefined;

        const terminalTabs = isTerminalBackedPanelKind(kind)
          ? collectWindowingTerminalTabSnapshots(store, ownerTabIds)
          : undefined;
        await openDetachedWindowState({
          sourceClientId: store.windowClientId,
          layoutTree: buildDetachedLayoutTree(kind, tabBinding),
          createdAt: Date.now(),
          ...(terminalTabs ? { terminalTabs } : {}),
        });
      },
      [store],
    );

    const terminalSignature = store.terminalTabs.map((tab) => tab.id).join("|");
    const chatSignature = store.chat.sessions
      .map((session) => session.id)
      .join("|");

    React.useEffect(() => {
      store.layout.syncPanelBindings({ persist: false });
    }, [chatSignature, store.layout, terminalSignature]);

    React.useEffect(() => {
      const element = canvasRef.current;
      if (!element) return;

      const updateViewport = () => {
        const bounds = element.getBoundingClientRect();
        store.layout.setViewport(bounds.width, bounds.height);
      };

      updateViewport();
      const observer =
        typeof ResizeObserver !== "undefined"
          ? new ResizeObserver(updateViewport)
          : null;
      observer?.observe(element);
      window.addEventListener("resize", updateViewport);

      return () => {
        observer?.disconnect();
        window.removeEventListener("resize", updateViewport);
      };
    }, [store.layout]);

    React.useEffect(() => {
      if (!layoutMenu) return;

      const handlePointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && menuRef.current?.contains(target)) return;
        setLayoutMenu(null);
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setLayoutMenu(null);
        }
      };

      window.addEventListener("mousedown", handlePointerDown);
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("resize", recomputeLayoutMenuStyle);
      window.addEventListener("scroll", recomputeLayoutMenuStyle, true);
      return () => {
        window.removeEventListener("mousedown", handlePointerDown);
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("resize", recomputeLayoutMenuStyle);
        window.removeEventListener("scroll", recomputeLayoutMenuStyle, true);
      };
    }, [layoutMenu, recomputeLayoutMenuStyle]);

    React.useEffect(() => {
      if (layoutMenu) return;
      setLayoutMenuStyle(undefined);
    }, [layoutMenu]);

    const isPointerOnTrash = React.useCallback(
      (
        targetElement: HTMLElement | null,
        clientX: number,
        clientY: number,
      ): boolean => {
        const trashElement = trashRef.current;
        if (!trashElement) return false;
        if (targetElement && trashElement.contains(targetElement)) return true;
        const rect = trashElement.getBoundingClientRect();
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      },
      [],
    );

    const isPointerOnDetach = React.useCallback(
      (
        targetElement: HTMLElement | null,
        clientX: number,
        clientY: number,
      ): boolean => {
        const detachElement = detachRef.current;
        if (!detachElement) return false;
        if (targetElement && detachElement.contains(targetElement)) return true;
        const rect = detachElement.getBoundingClientRect();
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      },
      [],
    );

    const requestDetachPanelToWindow = React.useCallback(
      (panelId: string) => {
        void detachPanelToWindow(panelId);
      },
      [detachPanelToWindow],
    );

    const requestDetachTabToWindow = React.useCallback(
      (payload: TabDragPayload) => {
        void detachTabToWindow(payload);
      },
      [detachTabToWindow],
    );

    const resolveTabBarReorderHint = React.useCallback(
      (
        tabBarElement: HTMLElement,
        targetPanelId: string,
        draggingTabId: string,
        clientX: number,
      ): {
        anchorTabId: string | null;
        position: "before" | "after";
        indicatorRect: LayoutRect;
      } | null => {
        const tabElements = Array.from(
          tabBarElement.querySelectorAll<HTMLElement>("[data-layout-tab-id]"),
        )
          .filter(
            (element) =>
              element.getAttribute("data-layout-tab-panel-id") ===
                targetPanelId &&
              element.getAttribute("data-layout-tab-menu-item") !== "true",
          )
          .map((element) => {
            const tabId = element.getAttribute("data-layout-tab-id");
            if (!tabId || tabId === draggingTabId) return null;
            return {
              tabId,
              rect: element.getBoundingClientRect(),
            };
          })
          .filter(
            (entry): entry is { tabId: string; rect: DOMRect } => !!entry,
          );

        return resolveHorizontalTabBarReorderHint(
          tabBarElement.getBoundingClientRect(),
          tabElements,
          draggingTabId,
          clientX,
        );
      },
      [],
    );

    const updateDropTarget = React.useCallback(
      (targetElement: HTMLElement | null, clientX: number, clientY: number) => {
        const panelHost = targetElement?.closest?.(
          "[data-layout-panel-id]",
        ) as HTMLElement | null;
        const targetPanelId =
          panelHost?.getAttribute("data-layout-panel-id") || null;
        const targetPanelKind = panelHost?.getAttribute(
          "data-layout-panel-kind",
        ) as PanelKind | null;

        if (store.layout.dragType === "tab") {
          const draggingTab = store.layout.draggingTab;
          const compactMenuTabElement = targetElement?.closest?.(
            '[data-layout-tab-menu-item="true"]',
          ) as HTMLElement | null;
          const compactMenuTabId =
            compactMenuTabElement?.getAttribute("data-layout-tab-id") || null;
          const compactMenuPanelId =
            compactMenuTabElement?.getAttribute("data-layout-tab-panel-id") ||
            null;
          const compactMenuKind = compactMenuTabElement?.getAttribute(
            "data-layout-tab-kind",
          ) as PanelKind | null;

          if (
            draggingTab &&
            compactMenuTabElement &&
            compactMenuTabId &&
            compactMenuPanelId &&
            compactMenuKind === draggingTab.kind
          ) {
            if (compactMenuTabId === draggingTab.tabId) {
              clearTabInsertIndicator();
              store.layout.clearTabReorderTarget();
              store.layout.setDropTarget(null, null);
              return;
            }

            const reorderHint = resolveCompactMenuTabReorderHint(
              {
                tabId: compactMenuTabId,
                rect: compactMenuTabElement.getBoundingClientRect(),
              },
              draggingTab.tabId,
              clientY,
            );
            if (reorderHint) {
              store.layout.setTabReorderTarget(
                compactMenuPanelId,
                reorderHint.anchorTabId,
                reorderHint.position,
              );
              store.layout.setDropTarget(compactMenuPanelId, "center");
              setTabInsertIndicatorRect(reorderHint.indicatorRect);
              return;
            }
          }

          const tabBarElement = targetElement?.closest?.(
            '[data-layout-tab-bar="true"]',
          ) as HTMLElement | null;
          const tabBarPanelId =
            tabBarElement?.getAttribute("data-layout-tab-panel-id") || null;
          const tabBarKind = tabBarElement?.getAttribute(
            "data-layout-tab-kind",
          ) as PanelKind | null;

          if (
            draggingTab &&
            tabBarElement &&
            tabBarPanelId &&
            tabBarKind === draggingTab.kind
          ) {
            const reorderHint = resolveTabBarReorderHint(
              tabBarElement,
              tabBarPanelId,
              draggingTab.tabId,
              clientX,
            );
            if (reorderHint) {
              store.layout.setTabReorderTarget(
                tabBarPanelId,
                reorderHint.anchorTabId,
                reorderHint.position,
              );
              store.layout.setDropTarget(tabBarPanelId, "center");
              setTabInsertIndicatorRect(reorderHint.indicatorRect);
              return;
            }
          }
        }

        clearTabInsertIndicator();
        if (!panelHost || !targetPanelId) {
          store.layout.clearTabReorderTarget();
          store.layout.setDropTarget(null, null);
          return;
        }

        if (
          store.layout.dragType === "panel" &&
          targetPanelId === store.layout.draggingPanelId
        ) {
          store.layout.clearTabReorderTarget();
          store.layout.setDropTarget(null, null);
          return;
        }

        const rawTabHost =
          (targetElement?.closest?.(
            "[data-layout-tab-id]",
          ) as HTMLElement | null) || null;
        const tabHost =
          rawTabHost?.getAttribute("data-layout-tab-menu-item") === "true"
            ? null
            : rawTabHost;
        const draggingTab =
          store.layout.dragType === "tab" ? store.layout.draggingTab : null;
        if (store.layout.dragType === "tab") {
          if (!draggingTab || !targetPanelKind) {
            store.layout.clearTabReorderTarget();
            store.layout.setDropTarget(null, null);
            return;
          }

          const targetTabId =
            tabHost?.getAttribute("data-layout-tab-id") || null;
          const targetTabPanelId =
            tabHost?.getAttribute("data-layout-tab-panel-id") || null;
          if (
            targetPanelKind === draggingTab.kind &&
            targetTabId &&
            targetTabId === draggingTab.tabId
          ) {
            store.layout.clearTabReorderTarget();
            store.layout.setDropTarget(null, null);
            return;
          }
          if (
            targetPanelKind === draggingTab.kind &&
            tabHost &&
            targetTabId &&
            targetTabPanelId === targetPanelId &&
            targetTabId !== draggingTab.tabId
          ) {
            const tabRect = tabHost.getBoundingClientRect();
            const position =
              clientX < tabRect.left + tabRect.width / 2 ? "before" : "after";
            store.layout.setTabReorderTarget(
              targetPanelId,
              targetTabId,
              position,
            );
            store.layout.setDropTarget(targetPanelId, "center");
            return;
          }
        }

        store.layout.clearTabReorderTarget();
        const rect = panelHost.getBoundingClientRect();
        const panelRect = {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
        const direction =
          store.layout.dragType === "panel" &&
          store.layout.draggingExternalPanelKind
            ? resolveExternalPanelDropDirection(panelRect, clientX, clientY)
            : determineDropDirection(panelRect, clientX, clientY);
        if (
          draggingTab &&
          targetPanelKind &&
          targetPanelKind !== draggingTab.kind &&
          direction === "center"
        ) {
          store.layout.setDropTarget(null, null);
          return;
        }
        store.layout.setDropTarget(targetPanelId, direction);
      },
      [clearTabInsertIndicator, resolveTabBarReorderHint, store.layout],
    );

    React.useEffect(() => {
      const host = rootRef.current;
      if (!host) return;

      const isPointInsideHost = (clientX: number, clientY: number): boolean => {
        const rect = host.getBoundingClientRect();
        return (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        );
      };

      const resolvePanelDragPayload = (
        payload: WindowingPanelDragPayload | null,
      ): WindowingPanelDragPayload | null => {
        if (!payload) {
          return null;
        }
        // Cross-window panel drags only ship a lightweight transport payload
        // through native drag data. Rehydrate the full tab/file-editor state
        // from storage before the target window decides whether it can import.
        const token = String(payload.stateToken || "").trim();
        if (!token) {
          return payload;
        }
        const stashedPayload = readPanelDragState(token);
        if (!stashedPayload) {
          return payload;
        }
        return {
          ...stashedPayload,
          sourceClientId: payload.sourceClientId,
          sourcePanelId: payload.sourcePanelId,
          kind: payload.kind,
          stateToken: token,
        };
      };

      const resolveTabDragPayload = (
        payload: CrossWindowTabDragPayload | null,
      ): CrossWindowTabDragPayload | null => {
        if (!payload) {
          return null;
        }
        const token = String(payload.stateToken || "").trim();
        if (!token) {
          return payload;
        }
        const stashedPayload = readTabDragState(token);
        if (!stashedPayload) {
          return payload;
        }
        return {
          ...stashedPayload,
          sourceClientId: payload.sourceClientId,
          tabId: payload.tabId,
          sourcePanelId: payload.sourcePanelId,
          kind: payload.kind,
          stateToken: token,
        };
      };

      const readTabPayload = (
        target: EventTarget | null,
      ): TabDragPayload | null => {
        const tabElement = (target as HTMLElement | null)?.closest?.(
          "[data-layout-tab-id]",
        ) as HTMLElement | null;
        if (!tabElement) return null;
        const tabId = tabElement.getAttribute("data-layout-tab-id");
        const kind = tabElement.getAttribute("data-layout-tab-kind");
        const sourcePanelId = tabElement.getAttribute(
          "data-layout-tab-panel-id",
        );
        if (
          !tabId ||
          !sourcePanelId ||
          (kind !== "chat" &&
            kind !== "terminal" &&
            kind !== "filesystem" &&
            kind !== "fileEditor" &&
            kind !== "monitor" &&
            kind !== "listPanel")
        ) {
          return null;
        }
        if (!getPanelKindAdapter(kind).supportsTabs) {
          return null;
        }
        return {
          tabId,
          kind,
          sourcePanelId,
        };
      };

      const isPortaledCompactTabMenuTarget = (
        target: EventTarget | null,
      ): boolean => {
        const element = target as HTMLElement | null;
        if (!element || typeof element.closest !== "function") {
          return false;
        }
        return Boolean(element.closest(".gyshell-compact-tab-menu"));
      };

      const readPanelDragSourceElement = (
        target: EventTarget | null,
      ): HTMLElement | null => {
        const targetElement = target as HTMLElement | null;
        if (!targetElement || typeof targetElement.closest !== "function") {
          return null;
        }
        if (targetElement.closest("button")) {
          return null;
        }
        if (targetElement.closest('[data-layout-tab-draggable="true"]')) {
          return null;
        }
        return targetElement.closest(
          '[data-layout-panel-draggable="true"]',
        ) as HTMLElement | null;
      };

      const readPanelPayload = (
        target: EventTarget | null,
      ): LocalPanelDragPayload | null => {
        const panelDragSource = readPanelDragSourceElement(target);
        if (!panelDragSource) return null;
        const panelId = panelDragSource.getAttribute("data-layout-panel-id");
        const kind = panelDragSource.getAttribute(
          "data-layout-panel-kind",
        ) as PanelKind | null;
        if (
          !panelId ||
          (kind !== "chat" &&
            kind !== "terminal" &&
            kind !== "filesystem" &&
            kind !== "fileEditor" &&
            kind !== "monitor" &&
            kind !== "listPanel")
        ) {
          return null;
        }
        // A cross-window panel move removes the source panel from this window after
        // the target confirms the drop. Keep the last panel in a window non-movable.
        // Do not add kind-scoped guards here. The only hard block is leaving the
        // current window with zero panels; being the last panel of a kind is fine.
        if (!store.layout.canRemovePanel(panelId) && !store.isDetachedWindow) {
          return null;
        }
        if (!store.canClosePanel(kind)) {
          return null;
        }
        return {
          panelId,
          kind,
        };
      };

      const readTransferredTerminalTabSnapshot = (
        tabId: string,
      ): WindowingTerminalTabSnapshot | undefined => {
        return collectWindowingTerminalTabSnapshots(store, [tabId])?.[0];
      };

      const readTransferredTerminalTabSnapshotsForPanel = (
        panelId: string,
        kind: PanelKind,
      ): WindowingTerminalTabSnapshot[] | undefined => {
        if (!isTerminalBackedPanelKind(kind)) {
          return undefined;
        }
        return collectWindowingTerminalTabSnapshots(
          store,
          store.layout.getPanelTabIds(panelId),
        );
      };

      const toCrossWindowTabDragPayload = (
        payload: TabDragPayload,
      ): CrossWindowTabDragPayload => {
        const terminalTab = readTransferredTerminalTabSnapshot(payload.tabId);
        return {
          ...payload,
          sourceClientId: store.windowClientId,
          ...(terminalTab ? { terminalTab } : {}),
        };
      };

      const createTabTransportPayload = (
        payload: TabDragPayload,
      ): CrossWindowTabDragPayload => {
        clearLocalTabDragState();
        const fullPayload = toCrossWindowTabDragPayload(payload);
        const stateToken = `tab-drag-${makeLayoutId("state")}`;
        const hasStashedState = stashTabDragState(stateToken, fullPayload);
        if (!hasStashedState) {
          return fullPayload;
        }
        localTabDragStateTokenRef.current = stateToken;
        return {
          sourceClientId: fullPayload.sourceClientId,
          tabId: fullPayload.tabId,
          sourcePanelId: fullPayload.sourcePanelId,
          kind: fullPayload.kind,
          stateToken,
        };
      };

      const toCrossWindowPanelDragPayload = (
        payload: LocalPanelDragPayload,
      ): WindowingPanelDragPayload => {
        const terminalTabs = readTransferredTerminalTabSnapshotsForPanel(
          payload.panelId,
          payload.kind,
        );
        return {
          sourceClientId: store.windowClientId,
          sourcePanelId: payload.panelId,
          kind: payload.kind,
          ...(getPanelKindAdapter(payload.kind).supportsTabs
            ? { tabBinding: toPanelTabBinding(payload.panelId, payload.kind) }
            : {}),
          ...(terminalTabs ? { terminalTabs } : {}),
          ...(payload.kind === "fileEditor"
            ? { fileEditorSnapshot: toPanelFileEditorSnapshot(payload.kind) }
            : {}),
        };
      };

      const createPanelTransportPayload = (
        payload: LocalPanelDragPayload,
      ): WindowingPanelDragPayload => {
        clearLocalPanelDragState();
        const fullPayload = toCrossWindowPanelDragPayload(payload);
        const stateToken = `panel-drag-${makeLayoutId("state")}`;
        const hasStashedState = stashPanelDragState(stateToken, fullPayload);
        if (!hasStashedState) {
          return fullPayload;
        }
        // Keep the native drag payload small. Electron can drop large/custom
        // DataTransfer bodies between BrowserWindows, especially when a panel
        // owns many tabs, so the transferable panel state lives in storage.
        localPanelDragStateTokenRef.current = stateToken;
        return {
          sourceClientId: fullPayload.sourceClientId,
          sourcePanelId: fullPayload.sourcePanelId,
          kind: fullPayload.kind,
          stateToken,
        };
      };

      const canImportResolvedExternalPanelPayload = (
        payload: WindowingPanelDragPayload | null,
      ): payload is WindowingPanelDragPayload => {
        if (!payload) {
          return false;
        }
        // Tabbed panels must be rehydrated before import. A transport payload that
        // still has only the state token is not safe to commit into the layout.
        if (
          getPanelKindAdapter(payload.kind).supportsTabs &&
          !payload.tabBinding
        ) {
          return false;
        }
        return true;
      };

      const ensurePanelDraggingFromEvent = (
        event: DragEvent,
      ): {
        externalPayload: WindowingPanelDragPayload | null;
        externalSourceClientId: string | null;
      } | null => {
        if (
          store.layout.isDragging &&
          store.layout.dragType === "panel" &&
          (store.layout.draggingPanelId ||
            store.layout.draggingExternalPanelKind)
        ) {
          return {
            externalPayload: externalPanelDragPayloadRef.current,
            externalSourceClientId: externalSourceClientIdRef.current,
          };
        }

        const pendingLocalPanelDrag = pendingLocalPanelDragRef.current;
        if (pendingLocalPanelDrag) {
          // Do not enter layout dragging during native dragstart. Chromium/Electron
          // may cancel the drag session if the source panel is visually mutated in
          // that same frame. The first dragover is the safe point to attach store state.
          store.layout.startPanelDragging(
            pendingLocalPanelDrag.panelId,
            event.clientX,
            event.clientY,
          );
          pendingLocalPanelDragRef.current = null;
          return {
            externalPayload: null,
            externalSourceClientId: null,
          };
        }

        const crossWindowPayload = parseCrossWindowPanelDragPayload(
          event.dataTransfer,
        );
        if (
          crossWindowPayload &&
          crossWindowPayload.sourceClientId !== store.windowClientId
        ) {
          // Prefer DataTransfer when available so the target can recover even if it
          // missed the drag-start broadcast while the pointer crossed windows.
          store.layout.startExternalPanelDragging(
            crossWindowPayload.kind,
            event.clientX,
            event.clientY,
          );
          externalSourceClientIdRef.current = crossWindowPayload.sourceClientId;
          externalPanelDragPayloadRef.current =
            resolvePanelDragPayload(crossWindowPayload);
          return {
            externalPayload: externalPanelDragPayloadRef.current,
            externalSourceClientId: crossWindowPayload.sourceClientId,
          };
        }

        const broadcastDrag = crossWindowDragRef.current;
        if (
          broadcastDrag?.dragKind === "panel" &&
          broadcastDrag.panelPayload &&
          broadcastDrag.sourceClientId !== store.windowClientId
        ) {
          // Broadcast is the fallback when Electron hides custom/native drag data
          // during dragover. The target still resolves the full payload from storage.
          store.layout.startExternalPanelDragging(
            broadcastDrag.panelPayload.kind,
            event.clientX,
            event.clientY,
          );
          externalSourceClientIdRef.current = broadcastDrag.sourceClientId;
          externalPanelDragPayloadRef.current = resolvePanelDragPayload(
            broadcastDrag.panelPayload,
          );
          return {
            externalPayload: externalPanelDragPayloadRef.current,
            externalSourceClientId: broadcastDrag.sourceClientId,
          };
        }

        return null;
      };

      const ensureTabDraggingFromEvent = (
        event: DragEvent,
      ): {
        payload: TabDragPayload;
        externalSourceClientId: string | null;
      } | null => {
        if (
          store.layout.isDragging &&
          store.layout.dragType === "tab" &&
          store.layout.draggingTab
        ) {
          return {
            payload: store.layout.draggingTab,
            externalSourceClientId: externalSourceClientIdRef.current,
          };
        }

        const pendingLocalTabDrag = pendingLocalTabDragRef.current;
        if (pendingLocalTabDrag) {
          // Mirror panel dragging: keep native dragstart lightweight so Chromium /
          // Electron can preserve the cross-window drag session before layout
          // state changes trigger any renderer work.
          store.layout.startTabDragging(
            pendingLocalTabDrag,
            event.clientX,
            event.clientY,
          );
          pendingLocalTabDragRef.current = null;
          return {
            payload: pendingLocalTabDrag,
            externalSourceClientId: null,
          };
        }

        // Try DataTransfer first (works for intra-window drags)
        const crossWindowPayload = parseCrossWindowTabDragPayload(
          event.dataTransfer,
        );
        const resolvedCrossWindowPayload =
          crossWindowPayload &&
          crossWindowPayload.sourceClientId !== store.windowClientId
            ? resolveTabDragPayload(crossWindowPayload)
            : null;
        if (
          resolvedCrossWindowPayload &&
          resolvedCrossWindowPayload.sourceClientId !== store.windowClientId
        ) {
          const payload: TabDragPayload = {
            tabId: resolvedCrossWindowPayload.tabId,
            kind: resolvedCrossWindowPayload.kind,
            sourcePanelId: resolvedCrossWindowPayload.sourcePanelId,
          };
          store.materializeTransferredTabs(payload.kind, [payload.tabId], {
            terminalTabs: resolvedCrossWindowPayload.terminalTab
              ? [resolvedCrossWindowPayload.terminalTab]
              : [],
          });
          store.unsuppressTabs(payload.kind, [payload.tabId], {
            syncLayout: false,
          });
          store.layout.startTabDragging(payload, event.clientX, event.clientY);
          externalSourceClientIdRef.current =
            resolvedCrossWindowPayload.sourceClientId;
          return {
            payload,
            externalSourceClientId: resolvedCrossWindowPayload.sourceClientId,
          };
        }

        // Fallback: use windowing channel payload (for cross-window drags where
        // DataTransfer.getData() returns empty during dragover)
        const broadcastDrag = crossWindowDragRef.current;
        const resolvedBroadcastPayload =
          broadcastDrag?.dragKind === "tab" && broadcastDrag.tabPayload
            ? resolveTabDragPayload(broadcastDrag.tabPayload)
            : null;
        if (
          broadcastDrag?.dragKind === "tab" &&
          resolvedBroadcastPayload &&
          broadcastDrag.sourceClientId !== store.windowClientId
        ) {
          const payload: TabDragPayload = {
            tabId: resolvedBroadcastPayload.tabId,
            kind: resolvedBroadcastPayload.kind,
            sourcePanelId: resolvedBroadcastPayload.sourcePanelId,
          };
          store.materializeTransferredTabs(payload.kind, [payload.tabId], {
            terminalTabs: resolvedBroadcastPayload.terminalTab
              ? [resolvedBroadcastPayload.terminalTab]
              : [],
          });
          store.unsuppressTabs(payload.kind, [payload.tabId], {
            syncLayout: false,
          });
          store.layout.startTabDragging(payload, event.clientX, event.clientY);
          externalSourceClientIdRef.current = broadcastDrag.sourceClientId;
          return {
            payload,
            externalSourceClientId: broadcastDrag.sourceClientId,
          };
        }

        return null;
      };

      const handleDragStart = (event: DragEvent) => {
        if (nativeDragStartHandledRef.current) {
          return;
        }

        const recentIntentTarget =
          Date.now() - pendingNativeDragIntentTimeRef.current <= 1200
            ? pendingNativeDragIntentTargetRef.current
            : null;
        const tabPayload =
          readTabPayload(event.target) || readTabPayload(recentIntentTarget);
        if (tabPayload) {
          nativeDragStartHandledRef.current = true;
          const crossPayload = createTabTransportPayload(tabPayload);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            const encoded = encodeCrossWindowTabDragPayload(crossPayload);
            event.dataTransfer.setData(LAYOUT_TAB_DRAG_MIME, encoded);
            event.dataTransfer.setData(
              "text/plain",
              `${LAYOUT_TAB_DRAG_TEXT_PREFIX}${encoded}`,
            );
          }
          setSelectionSuppressed(true);
          clearTabInsertIndicator();
          pendingLocalTabDragRef.current = tabPayload;
          externalSourceClientIdRef.current = null;
          // Broadcast to other windows so they can accept the drop
          postWindowingMessage({
            type: "drag-start",
            sourceClientId: store.windowClientId,
            dragKind: "tab",
            tabPayload: crossPayload,
          });
          return;
        }

        const panelPayload =
          readPanelPayload(event.target) ||
          readPanelPayload(recentIntentTarget);
        if (panelPayload) {
          nativeDragStartHandledRef.current = true;
          const crossPayload = createPanelTransportPayload(panelPayload);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            const dragSource = readPanelDragSourceElement(event.target);
            if (dragSource) {
              event.dataTransfer.setDragImage(
                dragSource,
                Math.min(
                  24,
                  Math.max(8, Math.round(dragSource.clientWidth / 4)),
                ),
                Math.min(
                  18,
                  Math.max(8, Math.round(dragSource.clientHeight / 2)),
                ),
              );
            }
            const encoded = encodeCrossWindowPanelDragPayload(crossPayload);
            event.dataTransfer.setData(LAYOUT_PANEL_DRAG_MIME, encoded);
            // Keep the plain-text fallback aligned with tab dragging. Electron can
            // hide custom MIME payloads across BrowserWindows, while text/plain is
            // still exposed to the target drag session.
            event.dataTransfer.setData(
              "text/plain",
              `${LAYOUT_PANEL_DRAG_TEXT_PREFIX}${encoded}`,
            );
          }
          setSelectionSuppressed(true);
          clearTabInsertIndicator();
          pendingLocalPanelDragRef.current = panelPayload;
          externalSourceClientIdRef.current = null;
          externalPanelDragPayloadRef.current = null;
          postWindowingMessage({
            type: "drag-start",
            sourceClientId: store.windowClientId,
            dragKind: "panel",
            panelPayload: crossPayload,
          });
        }
      };

      const handleDragMove = (event: DragEvent) => {
        const panelDragging = ensurePanelDraggingFromEvent(event);
        if (panelDragging) {
          event.preventDefault();
          store.layout.setDragPointer(event.clientX, event.clientY);
          const allowDropActions = !store.layout.draggingExternalPanelKind;
          const trashHover =
            allowDropActions &&
            isPointerOnTrash(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
          const detachHover =
            allowDropActions &&
            !store.isDetachedWindow &&
            isPointerOnDetach(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
          setTrashHover(trashHover);
          setDetachHover(detachHover);
          if (trashHover || detachHover) {
            clearDropPreview();
            if (event.dataTransfer) {
              event.dataTransfer.dropEffect = "move";
            }
            return;
          }
          updateDropTarget(
            event.target as HTMLElement | null,
            event.clientX,
            event.clientY,
          );
          if (event.dataTransfer) {
            const canDrop = store.layout.draggingExternalPanelKind
              ? !!store.layout.dropPreviewRect
              : !!store.layout.dropTargetPanelId;
            event.dataTransfer.dropEffect = canDrop ? "move" : "none";
          }
          return;
        }

        const dragging = ensureTabDraggingFromEvent(event);
        if (!dragging) return;
        event.preventDefault();
        store.layout.setDragPointer(event.clientX, event.clientY);

        const trashHover = isPointerOnTrash(
          event.target as HTMLElement | null,
          event.clientX,
          event.clientY,
        );
        const detachHover = store.isDetachedWindow
          ? false
          : isPointerOnDetach(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
        setTrashHover(trashHover);
        setDetachHover(detachHover);
        if (trashHover || detachHover) {
          clearDropPreview();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          return;
        }

        updateDropTarget(
          event.target as HTMLElement | null,
          event.clientX,
          event.clientY,
        );
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = store.layout.dropTargetPanelId
            ? "move"
            : "none";
        }
      };

      const handleDragEnter = (event: DragEvent) => {
        handleDragMove(event);
      };

      const handleDragOver = (event: DragEvent) => {
        handleDragMove(event);
      };

      const handleDragLeave = (event: DragEvent) => {
        if (
          !store.layout.isDragging ||
          (store.layout.dragType !== "tab" && store.layout.dragType !== "panel")
        )
          return;
        const rect = host.getBoundingClientRect();
        const outside =
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom;
        if (!outside) return;
        if (
          store.layout.dragType === "panel" &&
          externalSourceClientIdRef.current &&
          store.layout.draggingExternalPanelKind
        ) {
          cancelExternalPanelAdoption({ preserveCrossWindowDrag: true });
          return;
        }
        if (
          store.layout.dragType === "tab" &&
          externalSourceClientIdRef.current
        ) {
          cancelExternalTabAdoption({ preserveCrossWindowDrag: true });
          return;
        }
        clearDropPreview();
        setTrashHover(false);
        setDetachHover(false);
      };

      const handleDrop = (event: DragEvent) => {
        if (
          store.layout.isDragging &&
          store.layout.dragType === "panel" &&
          (store.layout.draggingPanelId ||
            store.layout.draggingExternalPanelKind)
        ) {
          event.preventDefault();
          store.layout.setDragPointer(event.clientX, event.clientY);
          const draggedPanelId = store.layout.draggingPanelId;
          const isExternalPanelDrag =
            !!store.layout.draggingExternalPanelKind && !draggedPanelId;
          const trashHover =
            !isExternalPanelDrag &&
            isPointerOnTrash(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
          const detachHover =
            !isExternalPanelDrag &&
            !store.isDetachedWindow &&
            isPointerOnDetach(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
          if (trashHover) {
            if (!draggedPanelId) {
              store.layout.clearDragging();
              resetDragUi();
              return;
            }
            store.layout.clearDragging();
            resetDragUi();
            requestClosePanel(draggedPanelId);
            return;
          }
          if (detachHover) {
            if (!draggedPanelId) {
              store.layout.clearDragging();
              resetDragUi();
              return;
            }
            store.layout.clearDragging();
            resetDragUi();
            requestDetachPanelToWindow(draggedPanelId);
            return;
          }
          updateDropTarget(
            event.target as HTMLElement | null,
            event.clientX,
            event.clientY,
          );
          if (draggedPanelId) {
            store.layout.commitDragging();
            resetDragUi();
            return;
          }

          const externalPayload = resolvePanelDragPayload(
            externalPanelDragPayloadRef.current,
          );
          const targetPanelId = store.layout.dropTargetPanelId;
          const dropDirection = store.layout.dropDirection;
          // By the time an external panel drop commits, the target must hold the
          // fully resolved panel state rather than the lightweight transport token.
          if (
            !canImportResolvedExternalPanelPayload(externalPayload) ||
            !targetPanelId ||
            !dropDirection ||
            !store.layout.dropPreviewRect
          ) {
            store.layout.clearDragging();
            resetDragUi();
            return;
          }

          const movedTabIds = externalPayload.tabBinding?.tabIds || [];
          if (movedTabIds.length > 0) {
            // External chat panels can carry tab IDs the target window has never
            // opened in this process. Materialize those inventory entries before
            // importPanelFromExternal() triggers syncPanelBindings().
            const materializedTabIds = store.materializeTransferredTabs(
              externalPayload.kind,
              movedTabIds,
              {
                terminalTabs: externalPayload.terminalTabs,
              },
            );
            store.unsuppressTabs(externalPayload.kind, materializedTabIds, {
              syncLayout: false,
            });
          }
          const importedPanelId = store.layout.importPanelFromExternal(
            externalPayload.kind,
            externalPayload.tabBinding,
            {
              panelId: targetPanelId,
              direction: dropDirection,
            },
          );
          if (!importedPanelId) {
            if (movedTabIds.length > 0) {
              store.suppressTabs(externalPayload.kind, movedTabIds, {
                syncLayout: false,
              });
            }
            store.layout.clearDragging();
            resetDragUi();
            return;
          }
          if (externalPayload.tabBinding?.activeTabId) {
            store.layout.setPanelActiveTab(
              importedPanelId,
              externalPayload.tabBinding.activeTabId,
            );
          }
          if (
            externalPayload.kind === "fileEditor" &&
            externalPayload.fileEditorSnapshot
          ) {
            store.fileEditor.restoreSnapshot(
              externalPayload.fileEditorSnapshot,
            );
          }
          // A placeholder chat session is enough to keep layout bindings stable
          // during drop, but background hydration is still required to restore the
          // transferred conversation history in the target window.
          store.hydrateTransferredTabs(externalPayload.kind, movedTabIds);
          postWindowingMessage({
            type: "panel-moved",
            sourceClientId: externalPayload.sourceClientId,
            targetClientId: store.windowClientId,
            sourcePanelId: externalPayload.sourcePanelId,
            kind: externalPayload.kind,
            tabIds: movedTabIds,
          });
          store.layout.clearDragging();
          resetDragUi();
          return;
        }

        const dragging = ensureTabDraggingFromEvent(event);
        if (!dragging) return;
        event.preventDefault();
        store.layout.setDragPointer(event.clientX, event.clientY);
        const draggingTab = store.layout.draggingTab;
        if (!draggingTab) {
          store.layout.clearDragging();
          resetDragUi();
          return;
        }
        const trashHover = isPointerOnTrash(
          event.target as HTMLElement | null,
          event.clientX,
          event.clientY,
        );
        const detachHover = store.isDetachedWindow
          ? false
          : isPointerOnDetach(
              event.target as HTMLElement | null,
              event.clientX,
              event.clientY,
            );
        if (trashHover && draggingTab) {
          store.layout.clearDragging();
          resetDragUi();
          requestCloseTabsByKind(draggingTab.kind, [draggingTab.tabId]);
          return;
        }
        if (detachHover && draggingTab) {
          store.layout.clearDragging();
          resetDragUi();
          requestDetachTabToWindow(draggingTab);
          return;
        }

        const externalSourceClientId =
          typeof dragging.externalSourceClientId === "string" &&
          dragging.externalSourceClientId !== store.windowClientId
            ? dragging.externalSourceClientId
            : null;
        const isExternalTabDrop = externalSourceClientId !== null;
        updateDropTarget(
          event.target as HTMLElement | null,
          event.clientX,
          event.clientY,
        );
        if (isExternalTabDrop && store.layout.dropTargetPanelId) {
          // Ensure the target window knows about a transferred chat tab before the
          // layout commit activates it and the renderer tries to resolve its tab id.
          store.materializeTransferredTabs(draggingTab.kind, [
            draggingTab.tabId,
          ]);
        }
        store.layout.commitDragging();
        let tabPresentInTarget = store.layout
          .getPanelIdsByKind(draggingTab.kind)
          .some((panelId) =>
            store.layout.getPanelTabIds(panelId).includes(draggingTab.tabId),
          );
        if (!tabPresentInTarget && isExternalTabDrop) {
          const targetPanelId = store.layout.ensurePrimaryPanelForKind(
            draggingTab.kind,
          );
          if (targetPanelId) {
            store.materializeTransferredTabs(draggingTab.kind, [
              draggingTab.tabId,
            ]);
            store.layout.attachTabToPanel(
              draggingTab.kind,
              draggingTab.tabId,
              targetPanelId,
            );
            tabPresentInTarget = store.layout
              .getPanelTabIds(targetPanelId)
              .includes(draggingTab.tabId);
          }
        }
        if (isExternalTabDrop && tabPresentInTarget) {
          store.hydrateTransferredTabs(draggingTab.kind, [draggingTab.tabId]);
          postWindowingMessage({
            type: "tab-moved",
            sourceClientId: externalSourceClientId,
            targetClientId: store.windowClientId,
            kind: draggingTab.kind,
            tabId: draggingTab.tabId,
          });
        } else if (isExternalTabDrop) {
          rollbackExternalTabDrag(draggingTab, externalSourceClientId);
        }
        resetDragUi();
      };

      const handleDragEnd = () => {
        const hasActiveLayoutDrag =
          (store.layout.isDragging &&
            (store.layout.dragType === "tab" ||
              store.layout.dragType === "panel")) ||
          !!pendingLocalTabDragRef.current ||
          !!pendingLocalPanelDragRef.current;
        if (!hasActiveLayoutDrag) {
          clearLocalTabDragState();
          clearLocalPanelDragState();
          return;
        }
        const externalSourceClientId = externalSourceClientIdRef.current;
        const draggingTab = store.layout.draggingTab;
        rollbackExternalTabDrag(draggingTab, externalSourceClientId);
        if (
          store.layout.isDragging &&
          (store.layout.dragType === "tab" || store.layout.dragType === "panel")
        ) {
          store.layout.clearDragging();
        }
        resetDragUi();
        // Notify other windows that the drag operation ended
        postWindowingMessage({
          type: "drag-end",
          sourceClientId: store.windowClientId,
        });
        crossWindowDragRef.current = null;
        clearLocalTabDragState();
        clearLocalPanelDragState();
      };

      const handlePointerDown = (event: MouseEvent) => {
        pendingNativeDragIntentTargetRef.current = event.target;
        pendingNativeDragIntentTimeRef.current = Date.now();
        nativeDragStartHandledRef.current = false;
      };

      const handleWindowPointerDown = (event: MouseEvent) => {
        if (!isPortaledCompactTabMenuTarget(event.target)) return;
        handlePointerDown(event);
      };

      const handlePointerUp = () => {
        if (store.layout.isDragging || pendingLocalPanelDragRef.current) {
          return;
        }
        pendingNativeDragIntentTargetRef.current = null;
        pendingNativeDragIntentTimeRef.current = 0;
        nativeDragStartHandledRef.current = false;
      };

      const handleWindowDragOver = (event: DragEvent) => {
        if (isPortaledCompactTabMenuTarget(event.target)) {
          handleDragMove(event);
          return;
        }
        if (
          !store.layout.isDragging ||
          (store.layout.dragType !== "tab" && store.layout.dragType !== "panel")
        )
          return;
        const inside = isPointInsideHost(event.clientX, event.clientY);
        if (inside) return;
        if (
          store.layout.dragType === "panel" &&
          externalSourceClientIdRef.current &&
          store.layout.draggingExternalPanelKind
        ) {
          cancelExternalPanelAdoption({ preserveCrossWindowDrag: true });
          return;
        }
        if (
          store.layout.dragType === "tab" &&
          externalSourceClientIdRef.current
        ) {
          cancelExternalTabAdoption({ preserveCrossWindowDrag: true });
          return;
        }
        clearDropPreview();
        setTrashHover(false);
        setDetachHover(false);
      };

      const handleWindowDrop = (event: DragEvent) => {
        if (isPortaledCompactTabMenuTarget(event.target)) {
          handleDrop(event);
          return;
        }
        const inside = isPointInsideHost(event.clientX, event.clientY);
        if (inside) {
          // window capture runs before the host drop handler. Never clear drag state
          // for an in-workspace drop here, or the actual commit handler will see
          // an empty drag session and the move will be lost.
          return;
        }
        if (
          store.layout.dragType === "panel" &&
          externalSourceClientIdRef.current &&
          store.layout.draggingExternalPanelKind
        ) {
          cancelExternalPanelAdoption();
          return;
        }
        if (
          store.layout.dragType === "tab" &&
          externalSourceClientIdRef.current
        ) {
          cancelExternalTabAdoption();
          return;
        }
        const externalSourceClientId = externalSourceClientIdRef.current;
        const draggingTab = store.layout.draggingTab;
        rollbackExternalTabDrag(draggingTab, externalSourceClientId);
        if (
          !store.layout.isDragging ||
          (store.layout.dragType !== "tab" && store.layout.dragType !== "panel")
        )
          return;
        store.layout.clearDragging();
        resetDragUi();
      };

      const handleWindowDragStart = (event: DragEvent) => {
        if (!isPortaledCompactTabMenuTarget(event.target)) return;
        handleDragStart(event);
      };

      const handleWindowDragEnter = (event: DragEvent) => {
        if (!isPortaledCompactTabMenuTarget(event.target)) return;
        handleDragMove(event);
      };

      const handleWindowDragEnd = (event: DragEvent) => {
        if (!isPortaledCompactTabMenuTarget(event.target)) return;
        handleDragEnd();
      };

      // Use capture so the workspace sees cross-window drags before nested
      // editors, terminals, or inputs claim the native drag session.
      host.addEventListener("mousedown", handlePointerDown, true);
      window.addEventListener("mousedown", handleWindowPointerDown, true);
      window.addEventListener("mouseup", handlePointerUp, true);
      host.addEventListener("dragstart", handleDragStart, true);
      host.addEventListener("dragenter", handleDragEnter, true);
      host.addEventListener("dragover", handleDragOver, true);
      host.addEventListener("dragleave", handleDragLeave, true);
      host.addEventListener("drop", handleDrop, true);
      host.addEventListener("dragend", handleDragEnd, true);
      window.addEventListener("dragstart", handleWindowDragStart, true);
      window.addEventListener("dragenter", handleWindowDragEnter, true);
      window.addEventListener("dragover", handleWindowDragOver, true);
      window.addEventListener("drop", handleWindowDrop, true);
      window.addEventListener("dragend", handleWindowDragEnd, true);

      return () => {
        host.removeEventListener("mousedown", handlePointerDown, true);
        window.removeEventListener("mousedown", handleWindowPointerDown, true);
        window.removeEventListener("mouseup", handlePointerUp, true);
        host.removeEventListener("dragstart", handleDragStart, true);
        host.removeEventListener("dragenter", handleDragEnter, true);
        host.removeEventListener("dragover", handleDragOver, true);
        host.removeEventListener("dragleave", handleDragLeave, true);
        host.removeEventListener("drop", handleDrop, true);
        host.removeEventListener("dragend", handleDragEnd, true);
        window.removeEventListener("dragstart", handleWindowDragStart, true);
        window.removeEventListener("dragenter", handleWindowDragEnter, true);
        window.removeEventListener("dragover", handleWindowDragOver, true);
        window.removeEventListener("drop", handleWindowDrop, true);
        window.removeEventListener("dragend", handleWindowDragEnd, true);
        clearLocalTabDragState();
        clearLocalPanelDragState();
      };
    }, [
      cancelExternalTabAdoption,
      clearLocalTabDragState,
      clearLocalPanelDragState,
      clearDropPreview,
      clearTabInsertIndicator,
      isPointerOnDetach,
      isPointerOnTrash,
      postWindowingMessage,
      requestCloseTabsByKind,
      requestClosePanel,
      requestDetachPanelToWindow,
      requestDetachTabToWindow,
      resetDragUi,
      rollbackExternalTabDrag,
      setDetachHover,
      setSelectionSuppressed,
      setTrashHover,
      store,
      store.layout,
      updateDropTarget,
    ]);

    const handleHeaderContextMenu = React.useCallback(
      (panelId: string, event: React.MouseEvent<HTMLElement>) => {
        event.preventDefault();
        const panelKind = store.layout.getPanelKindById(panelId);
        if (!panelKind) return;
        const tabElement = (event.target as HTMLElement | null)?.closest?.(
          "[data-layout-tab-id]",
        ) as HTMLElement | null;
        const targetTabId =
          tabElement?.getAttribute("data-layout-tab-id") || null;
        const targetTabPanelId =
          tabElement?.getAttribute("data-layout-tab-panel-id") || null;
        const mode: LayoutMenuMode =
          targetTabId && targetTabPanelId === panelId ? "tab" : "bar";
        setLayoutMenu({
          panelId,
          panelKind,
          mode,
          targetTabId: mode === "tab" ? targetTabId : null,
          x: event.clientX,
          y: event.clientY,
        });
      },
      [store.layout],
    );

    React.useEffect(() => {
      return () => {
        setSelectionSuppressed(false);
        setTrashHover(false);
        setDetachHover(false);
        clearTabInsertIndicator();
        store.layout.clearDragging();
      };
    }, [
      clearTabInsertIndicator,
      setDetachHover,
      setSelectionSuppressed,
      setTrashHover,
      store.layout,
    ]);

    const menuTabIds = layoutMenu
      ? store.layout.getPanelTabIds(layoutMenu.panelId)
      : [];
    const menuItems: Array<{
      action: LayoutMenuAction;
      labelKey: LayoutMenuLabelKey;
      danger?: boolean;
      disabled?: boolean;
    }> = (() => {
      if (!layoutMenu) return [];
      const canSplit = store.layout.panelCount < MAX_LAYOUT_PANELS;
      const canClosePanel = store.layout.canRemovePanel(layoutMenu.panelId);
      const canCloseTabs =
        getPanelKindAdapter(layoutMenu.panelKind).supportsTabs &&
        layoutMenu.panelKind !== "filesystem";

      if (layoutMenu.mode === "bar") {
        const items: Array<{
          action: LayoutMenuAction;
          labelKey: LayoutMenuLabelKey;
          danger?: boolean;
          disabled?: boolean;
        }> = [
          {
            action: "close-panel",
            labelKey: "closePanel",
            danger: true,
            disabled: !canClosePanel,
          },
        ];
        if (canCloseTabs) {
          items.push({
            action: "close-all-tabs",
            labelKey: "closeAllTabs",
            danger: true,
            disabled: menuTabIds.length === 0,
          });
        }
        return items;
      }

      const hasTargetTab =
        !!layoutMenu.targetTabId && menuTabIds.includes(layoutMenu.targetTabId);
      const targetTerminalTab =
        layoutMenu.panelKind === "terminal" && layoutMenu.targetTabId
          ? store.terminalTabs.find(
              (tab) => tab.id === layoutMenu.targetTabId,
            ) || null
          : null;
      const reconnectItems: Array<{
        action: LayoutMenuAction;
        labelKey: LayoutMenuLabelKey;
        danger?: boolean;
        disabled?: boolean;
      }> =
        targetTerminalTab &&
        canReconnectTerminalRuntime(
          targetTerminalTab.config,
          targetTerminalTab.runtimeState,
        )
          ? [
              {
                action: "reconnect-terminal",
                labelKey: "reconnectTab",
                disabled: !hasTargetTab,
              },
            ]
          : [];
      const closeItems: Array<{
        action: LayoutMenuAction;
        labelKey: LayoutMenuLabelKey;
        danger?: boolean;
        disabled?: boolean;
      }> = [
        {
          action: "close-tab",
          labelKey: "closeTab",
          danger: true,
          disabled: !canCloseTabs || !hasTargetTab,
        },
        {
          action: "close-other-tabs",
          labelKey: "closeOtherTabs",
          danger: true,
          disabled: !canCloseTabs || !hasTargetTab || menuTabIds.length <= 1,
        },
        {
          action: "close-all-tabs",
          labelKey: "closeAllTabs",
          danger: true,
          disabled: !canCloseTabs || menuTabIds.length === 0,
        },
      ];

      const splitItems = splitActions.map((entry) => ({
        action: entry.action,
        labelKey: entry.labelKey,
        disabled:
          !canSplit ||
          !hasTargetTab ||
          !store.layout.canSplitPanel(
            layoutMenu.panelId,
            layoutMenu.panelKind,
            entry.direction,
            entry.position,
          ),
      }));

      return [
        ...reconnectItems,
        ...closeItems,
        ...splitItems,
        {
          action: "close-panel",
          labelKey: "closePanel",
          danger: true,
          disabled: !canClosePanel,
        },
      ];
    })();

    const runMenuAction = React.useCallback(
      (action: LayoutMenuAction) => {
        if (!layoutMenu) return;
        const panelTabIds = store.layout.getPanelTabIds(layoutMenu.panelId);

        if (
          action === "reconnect-terminal" &&
          layoutMenu.panelKind === "terminal" &&
          layoutMenu.targetTabId
        ) {
          void store.reconnectTerminal(layoutMenu.targetTabId);
          setLayoutMenu(null);
          return;
        }

        if (action === "close-tab" && layoutMenu.targetTabId) {
          requestCloseTabsByKind(layoutMenu.panelKind, [
            layoutMenu.targetTabId,
          ]);
          setLayoutMenu(null);
          return;
        }

        if (action === "close-other-tabs" && layoutMenu.targetTabId) {
          requestCloseTabsByKind(
            layoutMenu.panelKind,
            panelTabIds.filter((tabId) => tabId !== layoutMenu.targetTabId),
          );
          setLayoutMenu(null);
          return;
        }

        if (action === "close-all-tabs") {
          requestCloseTabsByKind(layoutMenu.panelKind, panelTabIds);
          setLayoutMenu(null);
          return;
        }

        const splitEntry = splitActions.find(
          (entry) => entry.action === action,
        );
        if (splitEntry) {
          const dropDirection =
            splitEntry.direction === "horizontal"
              ? splitEntry.position === "before"
                ? "left"
                : "right"
              : splitEntry.position === "before"
                ? "top"
                : "bottom";

          if (layoutMenu.mode === "tab" && layoutMenu.targetTabId) {
            store.layout.splitTabToDirection(
              {
                tabId: layoutMenu.targetTabId,
                kind: layoutMenu.panelKind,
                sourcePanelId: layoutMenu.panelId,
              },
              layoutMenu.panelId,
              dropDirection,
            );
          }
          setLayoutMenu(null);
          return;
        }

        if (action === "close-panel") {
          requestClosePanel(layoutMenu.panelId);
          setLayoutMenu(null);
        }
      },
      [layoutMenu, requestClosePanel, requestCloseTabsByKind, store],
    );

    const targetRect = store.layout.dropTargetPanelId
      ? store.layout.getPanelRect(store.layout.dropTargetPanelId)
      : null;

    const pendingTerminalCloseCount =
      pendingTerminalCloseRequest?.tabIds.length || 0;

    React.useLayoutEffect(() => {
      if (!layoutMenu) return;
      recomputeLayoutMenuStyle();
    }, [layoutMenu, menuItems.length, recomputeLayoutMenuStyle]);

    return (
      <div ref={rootRef} className="gyshell-layout-root">
        {store.isDetachedWindow ? null : (
          <PanelTypeRail
            store={store}
            onPrimaryPanelUnavailable={(kind, intent) => {
              void openKindInDetachedWindow(kind, intent);
            }}
          />
        )}
        <div ref={canvasRef} className="gyshell-layout-canvas">
          <ConfirmDialog
            open={pendingTerminalCloseCount > 0}
            title={t.terminal.confirmCloseTitle}
            message={
              pendingTerminalCloseCount > 1
                ? t.terminal.confirmCloseManyMessage(pendingTerminalCloseCount)
                : t.terminal.confirmCloseMessage
            }
            confirmText={t.common.close}
            cancelText={t.common.cancel}
            danger
            onCancel={() => setPendingTerminalCloseRequest(null)}
            onConfirm={() => {
              const request = pendingTerminalCloseRequest;
              if (!request) return;
              setPendingTerminalCloseRequest(null);
              void (async () => {
                for (const tabId of request.tabIds) {
                  await store.closeTab(tabId);
                }
              })();
            }}
          />

          <LayoutNodeView
            node={store.layout.tree.root}
            store={store}
            onHeaderContextMenu={handleHeaderContextMenu}
            onRequestCloseTabsByKind={requestCloseTabsByKind}
            onRequestOpenTabInDetachedWindow={requestDetachTabToWindow}
          />

          {store.layout.isDragging ? (
            <DragOverlay
              targetRect={targetRect}
              previewRect={store.layout.dropPreviewRect}
            />
          ) : null}

          {store.layout.isDragging &&
          store.layout.dragType === "tab" &&
          tabInsertIndicatorRect ? (
            <div
              className="gyshell-layout-tab-insert-indicator"
              style={{
                left: tabInsertIndicatorRect.left,
                top: tabInsertIndicatorRect.top,
                width: tabInsertIndicatorRect.width,
                height: tabInsertIndicatorRect.height,
              }}
            />
          ) : null}

          {store.layout.isDragging ? (
            <div className="gyshell-layout-drop-actions">
              <div
                ref={trashRef}
                className={clsx("gyshell-layout-trash-drop", {
                  "is-hot": isTrashHover,
                })}
                data-layout-trash-drop="true"
              >
                <Trash2 size={16} strokeWidth={2.2} />
              </div>
              {store.isDetachedWindow ? null : (
                <div
                  ref={detachRef}
                  className={clsx("gyshell-layout-detach-drop", {
                    "is-hot": isDetachHover,
                  })}
                  title={t.layout.detachToWindow}
                  data-layout-detach-drop="true"
                >
                  {/* Detached windows intentionally omit a secondary merge-back
                    affordance. Supported return flows use direct cross-window
                    drag/drop rather than a dedicated detach action in-place. */}
                  <ExternalLink size={16} strokeWidth={2.2} />
                </div>
              )}
            </div>
          ) : null}

          {layoutMenu ? (
            <div
              ref={menuRef}
              className="gyshell-layout-menu"
              style={
                layoutMenuStyle || {
                  left: layoutMenu.x,
                  top: layoutMenu.y,
                  visibility: "hidden",
                }
              }
            >
              {menuItems.map((item) => (
                <button
                  key={item.action}
                  className={clsx("gyshell-layout-menu-item", {
                    "is-danger": item.danger,
                    "is-disabled": item.disabled,
                  })}
                  disabled={item.disabled}
                  onClick={() => runMenuAction(item.action)}
                >
                  {t.layout[item.labelKey]}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);
