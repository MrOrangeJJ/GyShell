import React from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { observer } from "mobx-react-lite";
import {
  Check,
  GripVertical,
  MessageSquare,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import type { AppStore, TerminalTabModel } from "../../stores/AppStore";
import type { ChatSession } from "../../stores/ChatStore";
import type { TabDragPayload } from "../../layout";
import {
  getTerminalConnectionIconKind,
  resolveTerminalRuntimeIndicatorState,
} from "../../lib/terminalConnectionModel";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import { normalizeSessionTitleText } from "../../lib/sessionTitleDisplay";
import { TerminalAddButton } from "../Terminal/TerminalAddButton";
import { resolveTerminalTabIcon } from "../Terminal/terminalTabIcons";
import {
  buildListPanelRows,
  resolveCreatedTerminalTabActivation,
  resolveListPanelChatStatusLabel,
  resolveListPanelRowContextAction,
  resolveListPanelRowActivation,
  type ListPanelRowContextAction,
  type ListPanelRow,
  type ListPanelTabKind,
  type ListPanelTabSource,
} from "./listPanelModel";
import "./listPanel.scss";

interface ListPanelProps {
  store: AppStore;
  panelId: string;
  onRequestCloseTabsByKind?: (kind: ListPanelTabKind, tabIds: string[]) => void;
  onRequestOpenTabInDetachedWindow?: (payload: TabDragPayload) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

interface ListPanelRowContextMenuState {
  rowId: string;
  action: ListPanelRowContextAction;
  x: number;
  y: number;
}

interface ListPanelChatRenameState {
  sessionId: string;
  draft: string;
  saving: boolean;
  error: string | null;
}

const getTerminalSubtitle = (
  store: AppStore,
  tab: TerminalTabModel,
): string => {
  const configType = String((tab.config as { type?: string }).type || "");
  if (configType === "local") {
    return store.i18n.t.terminal.local;
  }
  if (configType === "ssh") {
    return "SSH";
  }
  return configType || tab.id;
};

const buildTerminalSources = (store: AppStore): ListPanelTabSource[] =>
  store.terminalTabs.map((tab, index) => ({
    id: tab.id,
    kind: "terminal",
    title: tab.title || tab.config.title || tab.id,
    subtitle: getTerminalSubtitle(store, tab),
    statusLabel: tab.runtimeState || "initializing",
    updatedAt: index,
  }));

interface ChatSourceLabels {
  messages: (count: number) => string;
  running: string;
  ready: string;
}

const buildChatSources = (
  sessions: readonly ChatSession[],
  labels: ChatSourceLabels,
): ListPanelTabSource[] =>
  sessions.map((session, index) => {
    const lastMessageId = session.messageIds[session.messageIds.length - 1];
    const lastMessageTimestamp = lastMessageId
      ? session.messagesById.get(lastMessageId)?.timestamp
      : undefined;
    return {
      id: session.id,
      kind: "chat",
      title: normalizeSessionTitleText(session.title),
      subtitle:
        session.messageIds.length > 0
          ? labels.messages(session.messageIds.length)
          : session.isSessionBusy
            ? labels.running
            : labels.ready,
      statusLabel: resolveListPanelChatStatusLabel(session.isSessionBusy),
      updatedAt: Number.isFinite(lastMessageTimestamp)
        ? lastMessageTimestamp
        : Number.MAX_SAFE_INTEGER - (sessions.length - index),
    };
  });

const getTerminalStatusClassName = (
  store: AppStore,
  row: ListPanelRow,
): string => {
  const tab = store.terminalTabs.find((entry) => entry.id === row.id);
  if (!tab) return "inactive";
  return resolveTerminalRuntimeIndicatorState(
    tab.config.type,
    tab.runtimeState || "initializing",
  );
};

const renderRowIcon = (store: AppStore, row: ListPanelRow): React.ReactNode => {
  if (row.kind === "chat") {
    return <MessageSquare size={15} strokeWidth={2.1} />;
  }
  const tab = store.terminalTabs.find((entry) => entry.id === row.id);
  const iconKind = tab
    ? getTerminalConnectionIconKind(tab.config.type)
    : "generic";
  const Icon = resolveTerminalTabIcon(iconKind);
  return <Icon size={15} strokeWidth={2.1} />;
};

export const ListPanel: React.FC<ListPanelProps> = observer(
  ({
    store,
    panelId,
    onRequestCloseTabsByKind,
    onRequestOpenTabInDetachedWindow,
    onLayoutHeaderContextMenu,
  }) => {
    const [mode, setMode] = React.useState<ListPanelTabKind>("terminal");
    const [rowContextMenu, setRowContextMenu] =
      React.useState<ListPanelRowContextMenuState | null>(null);
    const [rowContextMenuStyle, setRowContextMenuStyle] =
      React.useState<React.CSSProperties>();
    const [chatRename, setChatRename] =
      React.useState<ListPanelChatRenameState | null>(null);
    const rowContextMenuRef = React.useRef<HTMLDivElement | null>(null);
    const rowContextMenuTriggerRef = React.useRef<HTMLElement | null>(null);
    const t = store.i18n.t;
    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;

    const terminalRows = buildListPanelRows({
      sources: buildTerminalSources(store),
      visibleTabIds: store.getOwnedTabIds("terminal"),
      panelIds: store.layout.getPanelIdsByKind("terminal"),
      getPanelTabIds: (targetPanelId) =>
        store.layout.getPanelTabIds(targetPanelId),
      getPanelActiveTabId: (targetPanelId) =>
        store.layout.getPanelActiveTabId(targetPanelId),
      globalActiveTabId: store.activeTerminalId || null,
    });

    const chatRows = buildListPanelRows({
      sources: buildChatSources(store.chat.sessions, {
        messages: t.layout.listPanelChatMessages,
        running: t.layout.listPanelChatRunning,
        ready: t.layout.listPanelChatReady,
      }),
      visibleTabIds: store.getOwnedTabIds("chat"),
      panelIds: store.layout.getPanelIdsByKind("chat"),
      getPanelTabIds: (targetPanelId) =>
        store.layout.getPanelTabIds(targetPanelId),
      getPanelActiveTabId: (targetPanelId) =>
        store.layout.getPanelActiveTabId(targetPanelId),
      globalActiveTabId: store.chat.activeSessionId || null,
    });

    const rows = mode === "terminal" ? terminalRows : chatRows;
    const emptyLabel =
      mode === "terminal" ? t.layout.emptyTerminalTabs : t.layout.emptyChatTabs;

    const terminalAddTargetPanelId =
      store.layout.getPrimaryPanelId("terminal") || undefined;

    const resolveRowContextAction = React.useCallback(
      (row: ListPanelRow): ListPanelRowContextAction | null => {
        const terminalTab =
          row.kind === "terminal"
            ? store.terminalTabs.find((tab) => tab.id === row.id) || null
            : null;
        return resolveListPanelRowContextAction({
          kind: row.kind,
          terminalType: terminalTab?.config.type,
          terminalRuntimeState: terminalTab?.runtimeState,
        });
      },
      [store],
    );

    const recomputeRowContextMenuStyle = React.useCallback(() => {
      const menu = rowContextMenuRef.current;
      if (!rowContextMenu || !menu) return;

      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rowContextMenu.x,
          top: rowContextMenu.y,
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
      setRowContextMenuStyle({
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, [rowContextMenu]);

    const restoreRowContextTriggerFocus = React.useCallback(() => {
      const trigger = rowContextMenuTriggerRef.current;
      if (trigger) {
        window.requestAnimationFrame(() => trigger.focus());
      }
    }, []);

    const closeRowContextMenu = React.useCallback(
      (restoreFocus = false) => {
        setRowContextMenu(null);
        if (restoreFocus) {
          restoreRowContextTriggerFocus();
        }
      },
      [restoreRowContextTriggerFocus],
    );

    React.useEffect(() => {
      if (!rowContextMenu) return;

      const handlePointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (target && rowContextMenuRef.current?.contains(target)) return;
        closeRowContextMenu();
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          closeRowContextMenu(true);
        }
      };

      window.addEventListener("mousedown", handlePointerDown);
      window.addEventListener("keydown", handleKeyDown);
      window.addEventListener("resize", recomputeRowContextMenuStyle);
      window.addEventListener("scroll", recomputeRowContextMenuStyle, true);
      return () => {
        window.removeEventListener("mousedown", handlePointerDown);
        window.removeEventListener("keydown", handleKeyDown);
        window.removeEventListener("resize", recomputeRowContextMenuStyle);
        window.removeEventListener(
          "scroll",
          recomputeRowContextMenuStyle,
          true,
        );
      };
    }, [closeRowContextMenu, recomputeRowContextMenuStyle, rowContextMenu]);

    React.useEffect(() => {
      if (rowContextMenu) return;
      setRowContextMenuStyle(undefined);
    }, [rowContextMenu]);

    React.useLayoutEffect(() => {
      if (!rowContextMenu) return;
      recomputeRowContextMenuStyle();
    }, [recomputeRowContextMenuStyle, rowContextMenu]);

    React.useEffect(() => {
      if (!rowContextMenu || !rowContextMenuStyle) return;
      rowContextMenuRef.current
        ?.querySelector<HTMLButtonElement>('button[role="menuitem"]')
        ?.focus();
    }, [rowContextMenu, rowContextMenuStyle]);

    React.useEffect(() => {
      if (rowContextMenu) {
        const menuRow = rows.find((row) => row.id === rowContextMenu.rowId);
        if (
          !menuRow ||
          resolveRowContextAction(menuRow) !== rowContextMenu.action
        ) {
          closeRowContextMenu();
        }
      }
      if (
        chatRename &&
        !store.chat.sessions.some(
          (session) => session.id === chatRename.sessionId,
        )
      ) {
        setChatRename(null);
      }
    }, [
      chatRename,
      closeRowContextMenu,
      rowContextMenu,
      resolveRowContextAction,
      rows,
      store.chat.sessions,
    ]);

    const openTabInPrimaryPanel = React.useCallback(
      (kind: ListPanelTabKind, tabId: string, hostPanelId?: string | null) => {
        const targetPanelId =
          hostPanelId ||
          store.layout.getPrimaryPanelId(kind) ||
          store.layout.ensurePrimaryPanelForKind(kind);
        if (!targetPanelId) {
          onRequestOpenTabInDetachedWindow?.({
            tabId,
            kind,
            sourcePanelId: hostPanelId || panelId,
          });
          return;
        }
        store.layout.attachTabToPanel(kind, tabId, targetPanelId);
        store.layout.setPanelActiveTab(targetPanelId, tabId);
      },
      [onRequestOpenTabInDetachedWindow, panelId, store.layout],
    );

    const handleAddChat = React.useCallback(() => {
      const sessionId = store.chat.createSession();
      openTabInPrimaryPanel("chat", sessionId);
    }, [openTabInPrimaryPanel, store.chat]);

    const handleOpenRow = React.useCallback(
      (row: ListPanelRow) => {
        openTabInPrimaryPanel(row.kind, row.id, row.host?.panelId);
      },
      [openTabInPrimaryPanel],
    );

    const handleActivateRow = React.useCallback(
      (row: ListPanelRow) => {
        const activation = resolveListPanelRowActivation(row);
        if (activation.type === "select") {
          store.layout.setPanelActiveTab(activation.panelId, activation.tabId);
          return;
        }
        openTabInPrimaryPanel(
          activation.kind,
          activation.tabId,
          activation.hostPanelId,
        );
      },
      [openTabInPrimaryPanel, store.layout],
    );

    const handleTerminalTabCreated = React.useCallback(
      (tabId: string) => {
        const activation = resolveCreatedTerminalTabActivation({
          tabId,
          hostPanelId: store.layout.getPrimaryPanelId("terminal"),
        });
        if (activation.type === "none") {
          return;
        }
        store.layout.setPanelActiveTab(activation.panelId, activation.tabId);
      },
      [store.layout],
    );

    const handleCloseRow = React.useCallback(
      (row: ListPanelRow) => {
        if (onRequestCloseTabsByKind) {
          onRequestCloseTabsByKind(row.kind, [row.id]);
          return;
        }
        if (row.kind === "terminal") {
          void store.closeTab(row.id);
          return;
        }
        store.chat.closeSession(row.id);
      },
      [onRequestCloseTabsByKind, store],
    );

    const openRowContextMenu = React.useCallback(
      (
        row: ListPanelRow,
        trigger: HTMLElement,
        x: number,
        y: number,
      ): boolean => {
        const action = resolveRowContextAction(row);
        if (!action) {
          return false;
        }
        rowContextMenuTriggerRef.current = trigger;
        setRowContextMenuStyle(undefined);
        setRowContextMenu({
          rowId: row.id,
          action,
          x,
          y,
        });
        return true;
      },
      [resolveRowContextAction],
    );

    const handleRowContextMenu = React.useCallback(
      (event: React.MouseEvent<HTMLElement>, row: ListPanelRow) => {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest("button, input") ||
          chatRename?.sessionId === row.id
        ) {
          return;
        }
        if (
          !openRowContextMenu(
            row,
            event.currentTarget,
            event.clientX,
            event.clientY,
          )
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      [chatRename?.sessionId, openRowContextMenu],
    );

    const startChatRename = React.useCallback(
      (sessionId: string) => {
        const session = store.chat.getSessionById(sessionId);
        if (!session) return;
        setChatRename({
          sessionId,
          draft: normalizeSessionTitleText(session.title),
          saving: false,
          error: null,
        });
      },
      [store.chat],
    );

    const cancelChatRename = React.useCallback(() => {
      if (chatRename?.saving) return;
      setChatRename(null);
      restoreRowContextTriggerFocus();
    }, [chatRename?.saving, restoreRowContextTriggerFocus]);

    const commitChatRename = React.useCallback(async () => {
      if (!chatRename || chatRename.saving) return;
      const nextTitle = chatRename.draft.trim();
      const session = store.chat.getSessionById(chatRename.sessionId);
      if (!nextTitle || !session) {
        setChatRename(null);
        restoreRowContextTriggerFocus();
        return;
      }
      if (normalizeSessionTitleText(session.title) === nextTitle) {
        setChatRename(null);
        restoreRowContextTriggerFocus();
        return;
      }

      setChatRename({ ...chatRename, saving: true, error: null });
      try {
        await store.chat.renameChatSession(chatRename.sessionId, nextTitle);
        setChatRename((current) =>
          current?.sessionId === chatRename.sessionId ? null : current,
        );
        restoreRowContextTriggerFocus();
      } catch {
        setChatRename((current) =>
          current?.sessionId === chatRename.sessionId
            ? {
                ...current,
                saving: false,
                error: t.chat.history.renameSessionFailed,
              }
            : current,
        );
      }
    }, [
      chatRename,
      restoreRowContextTriggerFocus,
      store.chat,
      t.chat.history.renameSessionFailed,
    ]);

    const runRowContextMenuAction = React.useCallback(() => {
      const menu = rowContextMenu;
      if (!menu) return;
      setRowContextMenu(null);
      if (menu.action === "reconnect") {
        void store.reconnectTerminal(menu.rowId);
        restoreRowContextTriggerFocus();
        return;
      }
      startChatRename(menu.rowId);
    }, [
      restoreRowContextTriggerFocus,
      rowContextMenu,
      startChatRename,
      store,
    ]);

    const changeMode = React.useCallback(
      (nextMode: ListPanelTabKind) => {
        closeRowContextMenu();
        setChatRename(null);
        setMode(nextMode);
      },
      [closeRowContextMenu],
    );

    const handlePanelMouseDownCapture = React.useCallback(() => {
      if (store.layout.tree.focusedPanelId !== panelId) {
        store.layout.setFocusedPanel(panelId);
      }
    }, [panelId, store.layout]);

    const renderRow = (row: ListPanelRow): React.ReactNode => {
      const statusClassName =
        row.kind === "terminal"
          ? getTerminalStatusClassName(store, row)
          : row.statusLabel;
      const contextAction = resolveRowContextAction(row);
      const isEditing = chatRename?.sessionId === row.id;
      const tooltip = row.host
        ? `${row.title} · panel ${row.host.panelIndex + 1}`
        : row.title;
      return (
        <div
          key={row.id}
          className={clsx("list-panel-row", {
            "is-active": row.active,
            "is-renaming": isEditing,
          })}
          role={isEditing ? undefined : "button"}
          tabIndex={isEditing ? -1 : 0}
          draggable={row.canDrag && !isEditing}
          title={isEditing ? undefined : tooltip}
          aria-haspopup={contextAction ? "menu" : undefined}
          aria-expanded={
            contextAction ? rowContextMenu?.rowId === row.id : undefined
          }
          onClick={() => {
            if (!isEditing) handleActivateRow(row);
          }}
          onDoubleClick={(event) => {
            if (isEditing) return;
            event.preventDefault();
            handleOpenRow(row);
          }}
          onKeyDown={(event) => {
            if (isEditing) return;
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              const rect = event.currentTarget.getBoundingClientRect();
              if (
                openRowContextMenu(
                  row,
                  event.currentTarget,
                  rect.left + Math.min(24, rect.width / 2),
                  rect.top + Math.min(rect.height, 28),
                )
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            handleActivateRow(row);
          }}
          onContextMenu={(event) => handleRowContextMenu(event, row)}
          data-layout-tab-draggable={isEditing ? undefined : "true"}
          data-layout-tab-id={row.id}
          data-layout-tab-kind={row.kind}
          data-layout-tab-panel-id={row.host?.panelId || panelId}
          data-layout-tab-index={row.host?.tabIndex || 0}
        >
          <div className="list-panel-row-accent" aria-hidden="true" />
          <div className="list-panel-row-icon" aria-hidden="true">
            {renderRowIcon(store, row)}
          </div>
          <div className="list-panel-row-text">
            {isEditing && chatRename ? (
              <input
                className="list-panel-row-rename-input"
                value={chatRename.draft}
                disabled={chatRename.saving}
                autoFocus
                aria-label={t.chat.history.renameSession}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  const draft = event.target.value;
                  setChatRename((current) =>
                    current?.sessionId === row.id
                      ? { ...current, draft, error: null }
                      : current,
                  );
                }}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitChatRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelChatRename();
                  }
                }}
              />
            ) : (
              <div className="list-panel-row-title">{row.title}</div>
            )}
            <div className="list-panel-row-subtitle">
              <span
                className={`list-panel-status-dot is-${statusClassName}`}
                aria-hidden="true"
              />
              <span>{row.subtitle}</span>
            </div>
            {isEditing && chatRename?.error ? (
              <span className="list-panel-row-rename-error" role="alert">
                {chatRename.error}
              </span>
            ) : null}
          </div>
          {isEditing && chatRename ? (
            <div className="list-panel-row-rename-actions">
              <button
                type="button"
                className="list-panel-row-rename-action"
                title={t.common.save}
                aria-label={t.common.save}
                disabled={chatRename.saving}
                onClick={(event) => {
                  event.stopPropagation();
                  void commitChatRename();
                }}
              >
                <Check size={13} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className="list-panel-row-rename-action"
                title={t.common.cancel}
                aria-label={t.common.cancel}
                disabled={chatRename.saving}
                onClick={(event) => {
                  event.stopPropagation();
                  cancelChatRename();
                }}
              >
                <X size={13} strokeWidth={2.2} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="list-panel-row-close"
              title={t.common.close}
              aria-label={t.common.close}
              onClick={(event) => {
                event.stopPropagation();
                handleCloseRow(row);
              }}
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          )}
        </div>
      );
    };

    return (
      <div
        className={clsx("panel panel-list-panel", {
          "is-dragging-source": isLayoutDragSource,
        })}
        onMouseDownCapture={handlePanelMouseDownCapture}
      >
        <div
          className="list-panel-header is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="listPanel"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          <span className="list-panel-header-title">
            {t.layout.listPanelKind}
          </span>
        </div>

        <div className="list-panel-modebar">
          <div
            className="list-panel-mode-tabs"
            role="tablist"
            aria-label={t.layout.listPanelKind}
          >
            <button
              type="button"
              className={clsx("list-panel-mode-tab", {
                "is-active": mode === "terminal",
              })}
              role="tab"
              aria-selected={mode === "terminal"}
              onClick={() => changeMode("terminal")}
            >
              <SquareTerminal size={14} strokeWidth={2.1} />
              <span className="list-panel-mode-label">
                {t.layout.terminalKind}
              </span>
              <span className="list-panel-mode-count">
                {terminalRows.length}
              </span>
            </button>
            <button
              type="button"
              className={clsx("list-panel-mode-tab", {
                "is-active": mode === "chat",
              })}
              role="tab"
              aria-selected={mode === "chat"}
              onClick={() => changeMode("chat")}
            >
              <MessageSquare size={14} strokeWidth={2.1} />
              <span className="list-panel-mode-label">{t.layout.chatKind}</span>
              <span className="list-panel-mode-count">{chatRows.length}</span>
            </button>
          </div>
          {mode === "terminal" ? (
            <TerminalAddButton
              store={store}
              targetPanelId={terminalAddTargetPanelId}
              ensurePanelOnCreate={false}
              className="list-panel-add"
              title={t.layout.addTerminalTab}
              ariaLabel={t.layout.addTerminalTab}
              onTabCreated={handleTerminalTabCreated}
              createSshInBackground
            />
          ) : (
            <button
              type="button"
              className="list-panel-add"
              title={t.layout.addChatSession}
              aria-label={t.layout.addChatSession}
              onClick={handleAddChat}
            >
              <Plus size={14} strokeWidth={2.2} />
            </button>
          )}
        </div>

        <div className="list-panel-body" data-list-panel-mode={mode}>
          {rows.length > 0 ? (
            rows.map((row) => renderRow(row))
          ) : (
            <div className="list-panel-empty">{emptyLabel}</div>
          )}
        </div>
        {rowContextMenu
          ? createPortal(
              <div
                ref={rowContextMenuRef}
                className="gyshell-layout-menu list-panel-row-context-menu"
                role="menu"
                style={
                  rowContextMenuStyle || {
                    left: rowContextMenu.x,
                    top: rowContextMenu.y,
                    visibility: "hidden",
                  }
                }
                onContextMenu={(event) => event.preventDefault()}
              >
                <button
                  type="button"
                  className="gyshell-layout-menu-item"
                  role="menuitem"
                  onClick={runRowContextMenuAction}
                >
                  {rowContextMenu.action === "reconnect"
                    ? t.layout.reconnectTab
                    : t.chat.history.renameSession}
                </button>
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  },
);
