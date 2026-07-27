import type { AppStore } from "./AppStore";
import type { PanelKind } from "../layout";

export interface PanelKindAdapter {
  kind: PanelKind;
  supportsTabs: boolean;
  maxPanels?: number;
  getOwnerTabIds: (appStore: AppStore) => string[];
  getGlobalActiveTabId: (appStore: AppStore) => string | null;
  isOwnerInventoryHydrated: (appStore: AppStore) => boolean;
  setGlobalActiveTab: (appStore: AppStore, tabId: string) => void;
}

const createPanelKindAdapter = (adapter: PanelKindAdapter): PanelKindAdapter =>
  adapter;

const resolveOwnedTabIds = (
  appStore: AppStore,
  kind: PanelKind,
  fallback: () => string[],
): string[] => {
  const runtime = appStore as AppStore & {
    getOwnedTabIds?: (panelKind: PanelKind) => string[];
  };
  if (typeof runtime.getOwnedTabIds === "function") {
    return runtime.getOwnedTabIds(kind);
  }
  return fallback();
};

const PANEL_KIND_ADAPTERS: Record<PanelKind, PanelKindAdapter> = {
  terminal: createPanelKindAdapter({
    kind: "terminal",
    supportsTabs: true,
    getOwnerTabIds: (appStore) =>
      resolveOwnedTabIds(appStore, "terminal", () =>
        appStore.terminalTabs.map((tab) => tab.id),
      ),
    getGlobalActiveTabId: (appStore) => appStore.activeTerminalId || null,
    isOwnerInventoryHydrated: (appStore) =>
      appStore.terminalTabsHydrated === true,
    setGlobalActiveTab: (appStore, tabId) => {
      appStore.setActiveTerminal(tabId);
    },
  }),
  chat: createPanelKindAdapter({
    kind: "chat",
    supportsTabs: true,
    getOwnerTabIds: (appStore) =>
      resolveOwnedTabIds(appStore, "chat", () =>
        appStore.chat.sessions.map((session) => session.id),
      ),
    getGlobalActiveTabId: (appStore) => appStore.chat.activeSessionId || null,
    isOwnerInventoryHydrated: (appStore) =>
      appStore.chat.sessionInventoryHydrated === true,
    setGlobalActiveTab: (appStore, tabId) => {
      appStore.chat.setActiveSession(tabId);
    },
  }),
  filesystem: createPanelKindAdapter({
    kind: "filesystem",
    supportsTabs: true,
    getOwnerTabIds: (appStore) =>
      resolveOwnedTabIds(appStore, "filesystem", () =>
        appStore.fileSystemTabs.map((tab) => tab.id),
      ),
    getGlobalActiveTabId: (appStore) => {
      if (
        appStore.activeTerminalId &&
        appStore.fileSystemTabs.some(
          (tab) => tab.id === appStore.activeTerminalId,
        )
      ) {
        return appStore.activeTerminalId;
      }
      return appStore.fileSystemTabs[0]?.id || null;
    },
    isOwnerInventoryHydrated: (appStore) =>
      appStore.terminalTabsHydrated === true,
    setGlobalActiveTab: (appStore, tabId) => {
      appStore.setActiveTerminal(tabId);
    },
  }),
  fileEditor: createPanelKindAdapter({
    kind: "fileEditor",
    supportsTabs: false,
    maxPanels: 1,
    getOwnerTabIds: () => [],
    getGlobalActiveTabId: () => null,
    isOwnerInventoryHydrated: () => true,
    setGlobalActiveTab: () => {
      // Special panel has no tab inventory to sync.
    },
  }),
  monitor: createPanelKindAdapter({
    kind: "monitor",
    supportsTabs: true,
    getOwnerTabIds: (appStore) =>
      resolveOwnedTabIds(appStore, "monitor", () =>
        appStore.monitorTabs.map((tab) => tab.id),
      ),
    getGlobalActiveTabId: (appStore) => {
      if (
        appStore.activeTerminalId &&
        appStore.monitorTabs.some((tab) => tab.id === appStore.activeTerminalId)
      ) {
        return appStore.activeTerminalId;
      }
      return appStore.monitorTabs[0]?.id || null;
    },
    isOwnerInventoryHydrated: (appStore) =>
      appStore.terminalTabsHydrated === true,
    setGlobalActiveTab: (appStore, tabId) => {
      appStore.setActiveTerminal(tabId);
    },
  }),
  listPanel: createPanelKindAdapter({
    kind: "listPanel",
    supportsTabs: false,
    maxPanels: 1,
    getOwnerTabIds: () => [],
    getGlobalActiveTabId: () => null,
    isOwnerInventoryHydrated: () => true,
    setGlobalActiveTab: () => {
      // The list panel is a shadow directory, not a tab owner.
    },
  }),
};

export const PANEL_KIND_LIST: readonly PanelKind[] = Object.freeze(
  Object.keys(PANEL_KIND_ADAPTERS) as PanelKind[],
);

export const getPanelKindAdapter = (kind: PanelKind): PanelKindAdapter =>
  PANEL_KIND_ADAPTERS[kind];
