import React from "react";
import { createPortal } from "react-dom";
import { GripVertical, MoreVertical, X } from "lucide-react";
import { observer } from "mobx-react-lite";
import type { AppStore, TerminalTabModel } from "../../stores/AppStore";
import "./terminal.scss";
import { PanelFindBar } from "../Common/PanelFindBar";
import { XTermView } from "./XTermView";
import type { XTermSearchHandle } from "./terminalSearchHandle";
import { resolveFloatingMenuPlacement } from "../../lib/menuPlacement";
import {
  getTerminalConnectionIconKind,
  resolveTerminalRuntimeIndicatorState,
} from "../../lib/terminalConnectionModel";
import { isLinux, isWindows } from "../../platform/platform";
import { CompactPanelTabSelect } from "../Layout/CompactPanelTabSelect";
import { TerminalAddButton } from "./TerminalAddButton";
import { resolvePanelTabBarMode } from "../Layout/panelHeaderPresentation";
import { resolveTerminalTabIcon } from "./terminalTabIcons";
import {
  formatCommandDraftShortcut,
  getDefaultCommandDraftShortcut,
  resolveCommandDraftShortcut,
} from "../../lib/commandDraftShortcut";
import { isFindShortcutEvent } from "../../lib/textSearch";

interface TerminalPanelProps {
  store: AppStore;
  panelId: string;
  tabs: TerminalTabModel[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onRequestCloseTabs?: (tabIds: string[]) => void;
  onLayoutHeaderContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}

export const TerminalPanel: React.FC<TerminalPanelProps> = observer(
  ({
    store,
    panelId,
    tabs,
    activeTabId,
    onSelectTab,
    onRequestCloseTabs,
    onLayoutHeaderContextMenu,
  }) => {
    const [openMenu, setOpenMenu] = React.useState<"add" | "more" | null>(null);
    const [commandDraftOpenRequest, setCommandDraftOpenRequest] =
      React.useState<{
        id: number;
        placement: "center" | "pointer";
        terminalId: string;
      } | null>(null);
    const [findOpen, setFindOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResultCount, setSearchResultCount] = React.useState(0);
    const [searchResultIndex, setSearchResultIndex] = React.useState(-1);
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const searchInputRef = React.useRef<HTMLInputElement | null>(null);
    const terminalViewRefs = React.useRef<
      Record<string, XTermSearchHandle | null>
    >({});
    const moreMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
    const moreMenuRef = React.useRef<HTMLDivElement | null>(null);
    const [menuStyle, setMenuStyle] = React.useState<
      React.CSSProperties | undefined
    >(undefined);
    const t = store.i18n.t;
    const isLayoutDragSource =
      store.layout.isDragging && store.layout.draggingPanelId === panelId;
    const panelRect = store.layout.getPanelRect(panelId);
    const layoutSignature = `${Math.round(panelRect?.width || 0)}x${Math.round(panelRect?.height || 0)}`;
    const tabBarMode = resolvePanelTabBarMode(
      "terminal",
      panelRect?.width || 0,
      tabs.length,
      store.panelTabDisplayMode,
    );
    const activeTab =
      tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
    const activeIconKind = activeTab
      ? getTerminalConnectionIconKind(activeTab.config.type)
      : "generic";
    const ActiveIcon = resolveTerminalTabIcon(activeIconKind);
    const activeRuntimeIndicatorState = activeTab
      ? resolveTerminalRuntimeIndicatorState(
          activeTab.config.type,
          activeTab.runtimeState || "initializing",
        )
      : "inactive";
    const resolvedCommandDraftShortcut = resolveCommandDraftShortcut(
      store.settings?.terminal?.commandDraftShortcut ??
        getDefaultCommandDraftShortcut(),
    );
    const commandDraftShortcutLabel = formatCommandDraftShortcut(
      resolvedCommandDraftShortcut,
      t.settings.shortcutDisabled,
    );
    const commandDraftShortcutHint = resolvedCommandDraftShortcut
      ? t.terminal.commandDraftShortcutHint(commandDraftShortcutLabel)
      : t.terminal.commandDraftShortcutDisabledHint;
    const menuPlatformClassName = React.useMemo(() => {
      if (isWindows()) return "is-platform-windows";
      if (isLinux()) return "is-platform-linux";
      return "";
    }, []);
    const normalizedSearchQuery = React.useMemo(
      () => searchQuery.trim(),
      [searchQuery],
    );

    const recomputeMenuPosition = React.useCallback(() => {
      const trigger = moreMenuButtonRef.current;
      const menu = moreMenuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const measured = menu.getBoundingClientRect();
      const placement = resolveFloatingMenuPlacement({
        anchorRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        menuWidth: Math.ceil(measured.width),
        menuHeight: Math.ceil(measured.height),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        margin: 8,
        gap: 4,
        preferredMaxHeight: 300,
      });

      setMenuStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        maxHeight: placement.maxHeight,
        maxWidth: placement.maxWidth,
      });
    }, []);

    React.useEffect(() => {
      if (openMenu !== "more") return;

      const onMouseDown = (event: MouseEvent) => {
        const target = event.target as Node | null;
        if (!target) return;
        if (
          moreMenuRef.current?.contains(target)
        ) {
          return;
        }
        if (moreMenuButtonRef.current?.contains(target)) {
          return;
        }
        setOpenMenu(null);
      };

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpenMenu(null);
      };

      const onReflow = () => {
        recomputeMenuPosition();
      };

      window.addEventListener("mousedown", onMouseDown);
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", onReflow);
      window.addEventListener("scroll", onReflow, true);
      return () => {
        window.removeEventListener("mousedown", onMouseDown);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", onReflow);
        window.removeEventListener("scroll", onReflow, true);
      };
    }, [openMenu, recomputeMenuPosition]);

    React.useLayoutEffect(() => {
      if (openMenu !== "more") return;
      recomputeMenuPosition();
    }, [openMenu, recomputeMenuPosition]);

    const focusSearchInput = React.useCallback(() => {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }, []);

    const openFind = React.useCallback(() => {
      setFindOpen(true);
      focusSearchInput();
    }, [focusSearchInput]);

    const clearAllTerminalSearches = React.useCallback(() => {
      Object.values(terminalViewRefs.current).forEach((handle) => {
        handle?.clearSearch();
      });
    }, []);

    const closeFind = React.useCallback(() => {
      setFindOpen(false);
      setSearchQuery("");
      setSearchResultCount(0);
      setSearchResultIndex(-1);
      clearAllTerminalSearches();
    }, [clearAllTerminalSearches]);

    const moveSearchResult = React.useCallback(
      (direction: "next" | "previous") => {
        const activeSearchHandle = activeTab
          ? terminalViewRefs.current[activeTab.id] || null
          : null;
        if (!activeSearchHandle || !normalizedSearchQuery) {
          return;
        }
        if (direction === "previous") {
          activeSearchHandle.findPrevious(normalizedSearchQuery);
          return;
        }
        activeSearchHandle.findNext(normalizedSearchQuery);
      },
      [activeTab?.id, normalizedSearchQuery],
    );

    const handlePanelKeyDownCapture = React.useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (!isFindShortcutEvent(event)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        openFind();
      },
      [openFind],
    );

    React.useEffect(() => {
      if (!findOpen) {
        return;
      }
      const activeSearchHandle = activeTab
        ? terminalViewRefs.current[activeTab.id] || null
        : null;
      if (!activeSearchHandle) {
        setSearchResultCount(0);
        setSearchResultIndex(-1);
        return;
      }
      activeSearchHandle.setSearchQuery(normalizedSearchQuery);
    }, [activeTab?.id, findOpen, normalizedSearchQuery]);

    return (
      <div
        className={`panel panel-terminal${isLayoutDragSource ? " is-dragging-source" : ""}`}
        ref={rootRef}
        onKeyDownCapture={handlePanelKeyDownCapture}
      >
        <div
          className="terminal-tabs-container is-draggable"
          draggable
          data-layout-panel-draggable="true"
          data-layout-panel-id={panelId}
          data-layout-panel-kind="terminal"
          onContextMenu={onLayoutHeaderContextMenu}
        >
          <div className="panel-tab-drag-handle" aria-hidden="true">
            <GripVertical size={12} strokeWidth={2.4} />
          </div>
          {tabBarMode === "select" ? (
            <CompactPanelTabSelect
              className="terminal-tabs-select"
              panelId={panelId}
              panelKind="terminal"
              value={activeTab?.id || null}
              options={tabs.map((tab) => {
                const iconKind = getTerminalConnectionIconKind(tab.config.type);
                const Icon = resolveTerminalTabIcon(iconKind);
                const runtimeIndicatorState =
                  resolveTerminalRuntimeIndicatorState(
                    tab.config.type,
                    tab.runtimeState || "initializing",
                  );
                return {
                  value: tab.id,
                  label: tab.title,
                  measureKey: tab.title,
                  leading: (
                    <span className="tab-icon">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                  ),
                  leadingMeasureKey: iconKind,
                  trailing: (
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={tab.runtimeState || "initializing"}
                    />
                  ),
                  trailingMeasureKey: runtimeIndicatorState,
                  onClose: () => {
                    if (onRequestCloseTabs) {
                      onRequestCloseTabs([tab.id]);
                      return;
                    }
                    void store.closeTab(tab.id);
                  },
                  closeTitle: t.common.close,
                  onContextMenu: onLayoutHeaderContextMenu
                    ? (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onLayoutHeaderContextMenu(event);
                      }
                    : undefined,
                };
              })}
              onChange={onSelectTab}
              leading={
                activeTab ? (
                  <span className="tab-icon">
                    <ActiveIcon size={14} strokeWidth={2} />
                  </span>
                ) : null
              }
              leadingMeasureKey={activeIconKind}
              trailing={
                activeTab ? (
                  <span
                    className={`tab-runtime-state tab-runtime-state-${activeRuntimeIndicatorState}`}
                    title={activeTab.runtimeState || "initializing"}
                  />
                ) : null
              }
              trailingMeasureKey={activeRuntimeIndicatorState}
              actions={
                activeTab ? (
                  <button
                    className="gyshell-compact-tab-select-action"
                    title={t.common.close}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (onRequestCloseTabs) {
                        onRequestCloseTabs([activeTab.id]);
                        return;
                      }
                      void store.closeTab(activeTab.id);
                    }}
                  >
                    <X size={12} strokeWidth={2.2} />
                  </button>
                ) : null
              }
            />
          ) : (
            <div
              className="terminal-tabs-bar"
              data-layout-tab-bar="true"
              data-layout-tab-panel-id={panelId}
              data-layout-tab-kind="terminal"
            >
              {tabs.map((tab, index) => {
                const isActive = tab.id === activeTabId;
                const runtimeState = tab.runtimeState || "initializing";
                const iconKind = getTerminalConnectionIconKind(tab.config.type);
                const Icon = resolveTerminalTabIcon(iconKind);
                const runtimeIndicatorState =
                  resolveTerminalRuntimeIndicatorState(
                    tab.config.type,
                    runtimeState,
                  );

                return (
                  <div
                    key={tab.id}
                    className={isActive ? "tab is-active" : "tab"}
                    onClick={() => onSelectTab(tab.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onLayoutHeaderContextMenu?.(event);
                    }}
                    role="button"
                    tabIndex={0}
                    draggable
                    data-layout-tab-draggable="true"
                    data-layout-tab-id={tab.id}
                    data-layout-tab-kind="terminal"
                    data-layout-tab-panel-id={panelId}
                    data-layout-tab-index={index}
                  >
                    <span className="tab-icon">
                      <Icon size={14} strokeWidth={2} />
                    </span>
                    <span className="tab-title">{tab.title}</span>
                    <span
                      className={`tab-runtime-state tab-runtime-state-${runtimeIndicatorState}`}
                      title={runtimeState}
                    />
                    <button
                      className="tab-close"
                      title={t.common.close}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (onRequestCloseTabs) {
                          onRequestCloseTabs([tab.id]);
                          return;
                        }
                        void store.closeTab(tab.id);
                      }}
                    >
                      <X size={12} strokeWidth={2.2} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="terminal-tabs-actions">
            <TerminalAddButton
              store={store}
              targetPanelId={panelId}
              className="tab-add-btn"
              title={t.terminal.newTab}
              ariaLabel={t.terminal.newTab}
              open={openMenu === "add"}
              onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? "add" : null)}
            />
            <button
              ref={moreMenuButtonRef}
              className="tab-more-btn"
              title={t.common.showMore}
              aria-label={t.common.showMore}
              aria-haspopup="menu"
              aria-expanded={openMenu === "more"}
              onClick={() =>
                setOpenMenu((current) => (current === "more" ? null : "more"))
              }
            >
              <MoreVertical size={14} strokeWidth={2} />
            </button>
          </div>
          {openMenu === "more"
            ? createPortal(
                <div
                  className={
                    menuPlatformClassName
                      ? `win-select-menu terminal-more-menu ${menuPlatformClassName}`
                      : "win-select-menu terminal-more-menu"
                  }
                  role="menu"
                  ref={moreMenuRef}
                  style={menuStyle}
                >
                  <button
                    className="win-select-option"
                    type="button"
                    role="menuitem"
                    disabled={!activeTab}
                    onClick={() => {
                      if (!activeTab) {
                        return;
                      }
                      setCommandDraftOpenRequest((current) => ({
                        id: (current?.id || 0) + 1,
                        placement: "center",
                        terminalId: activeTab.id,
                      }));
                      setOpenMenu(null);
                    }}
                  >
                    {t.terminal.commandDraftTitle}
                  </button>
                </div>,
                document.body,
              )
            : null}
        </div>

        {findOpen ? (
          <PanelFindBar
            inputRef={searchInputRef}
            value={searchQuery}
            placeholder={t.terminal.searchPlaceholder}
            resultLabel={
              normalizedSearchQuery
                ? searchResultCount > 0
                  ? t.common.findResults(
                      Math.max(0, searchResultIndex + 1),
                      searchResultCount,
                    )
                  : t.common.findNoResults
                : ""
            }
            onChange={setSearchQuery}
            onPrevious={() => moveSearchResult("previous")}
            onNext={() => moveSearchResult("next")}
            onClose={closeFind}
            disableNavigation={searchResultCount <= 0}
          />
        ) : null}

        <div className="panel-body">
          {tabs.length ? (
            <div className="terminal-stack">
              {tabs.map((tab) => {
                const isActive = tab.id === activeTabId;
                return (
                  <div
                    key={tab.id}
                    className={
                      isActive ? "terminal-layer is-active" : "terminal-layer"
                    }
                  >
                    <XTermView
                      ref={(handle) => {
                        terminalViewRefs.current[tab.id] = handle;
                      }}
                      config={tab.config}
                      theme={store.xtermTheme}
                      terminalSettings={store.settings?.terminal}
                      commandDraftLabels={{
                        title: t.terminal.commandDraftTitle,
                        placeholder: t.terminal.commandDraftPlaceholder,
                        send: t.terminal.commandDraftSend,
                        shortcutHint: commandDraftShortcutHint,
                        pending: t.terminal.commandDraftPending,
                        failed: t.terminal.commandDraftFailed,
                        noProfile: t.terminal.commandDraftNoProfile,
                      }}
                      commandDraftShortcut={resolvedCommandDraftShortcut}
                      commandDraftProfileId={store.commandDraftProfileId}
                      commandDraftProfileOptions={(
                        store.settings?.models.profiles || []
                      ).map((profile) => ({
                        id: profile.id,
                        name: profile.name,
                      }))}
                      onCommandDraftProfileChange={(profileId) => {
                        void store.setCommandDraftProfileId(profileId);
                      }}
                      commandDraftOpenRequest={commandDraftOpenRequest}
                      onCommandDraftOpenRequestHandled={(
                        requestId,
                        terminalId,
                      ) => {
                        setCommandDraftOpenRequest((current) => {
                          if (
                            !current ||
                            current.id !== requestId ||
                            current.terminalId !== terminalId
                          ) {
                            return current;
                          }
                          return null;
                        });
                      }}
                      remoteOs={tab.remoteOs}
                      systemInfo={tab.systemInfo}
                      isOwnedByUi={() =>
                        store.terminalTabs.some(
                          (candidate) => candidate.id === tab.id,
                        )
                      }
                      supportsFilesystem={
                        tab.capabilities.supportsFilesystem === true
                      }
                      isActive={isActive}
                      layoutSignature={layoutSignature}
                      onSelectionChange={(text) =>
                        store.setTerminalSelection(tab.id, text)
                      }
                      onSearchResultsChange={(payload) => {
                        if (tab.id !== activeTab?.id) {
                          return;
                        }
                        setSearchResultCount(payload.resultCount);
                        setSearchResultIndex(payload.resultIndex);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="placeholder">No Terminal</div>
          )}
        </div>
      </div>
    );
  },
);
