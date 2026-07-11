import { canReconnectTerminalRuntime } from "../../lib/terminalConnectionModel";

export type ListPanelTabKind = "terminal" | "chat";
export type ListPanelRowContextAction = "reconnect" | "rename";

export interface ListPanelHostInfo {
  panelId: string;
  panelIndex: number;
  tabIndex: number;
}

export interface ListPanelTabSource {
  id: string;
  kind: ListPanelTabKind;
  title: string;
  subtitle: string;
  statusLabel: string;
  updatedAt?: number;
}

export interface ListPanelRow extends ListPanelTabSource {
  host: ListPanelHostInfo | null;
  active: boolean;
  canDrag: boolean;
}

export type ListPanelRowActivation =
  | {
      type: "select";
      panelId: string;
      tabId: string;
    }
  | {
      type: "open";
      kind: ListPanelTabKind;
      tabId: string;
      hostPanelId: string | null;
    };

export type ListPanelCreatedTerminalActivation =
  | {
      type: "activate-host";
      panelId: string;
      tabId: string;
    }
  | {
      type: "none";
    };

export const resolveListPanelChatStatusLabel = (
  isSessionBusy: boolean,
): "running" | "inactive" => (isSessionBusy ? "running" : "inactive");

export const resolveListPanelRowContextAction = (input: {
  kind: ListPanelTabKind;
  terminalType?: string;
  terminalRuntimeState?: unknown;
}): ListPanelRowContextAction | null => {
  if (input.kind === "chat") {
    return "rename";
  }
  if (
    input.terminalType &&
    canReconnectTerminalRuntime(
      { type: input.terminalType },
      input.terminalRuntimeState,
    )
  ) {
    return "reconnect";
  }
  return null;
};

export const resolveListPanelHost = (
  panelIds: readonly string[],
  getPanelTabIds: (panelId: string) => readonly string[],
  tabId: string,
): ListPanelHostInfo | null => {
  const normalizedTabId = String(tabId || "").trim();
  if (!normalizedTabId) return null;

  for (let panelIndex = 0; panelIndex < panelIds.length; panelIndex += 1) {
    const panelId = panelIds[panelIndex];
    const tabIndex = getPanelTabIds(panelId).indexOf(normalizedTabId);
    if (tabIndex >= 0) {
      return {
        panelId,
        panelIndex,
        tabIndex,
      };
    }
  }

  return null;
};

export const buildListPanelRows = (input: {
  sources: readonly ListPanelTabSource[];
  visibleTabIds: readonly string[];
  panelIds: readonly string[];
  getPanelTabIds: (panelId: string) => readonly string[];
  getPanelActiveTabId: (panelId: string) => string | null;
  globalActiveTabId: string | null;
}): ListPanelRow[] => {
  const visibleSet = new Set(input.visibleTabIds);
  return input.sources
    .map((source, sourceIndex) => ({ source, sourceIndex }))
    .filter(({ source }) => visibleSet.has(source.id))
    .sort((left, right) => {
      const leftUpdatedAt = Number(left.source.updatedAt);
      const rightUpdatedAt = Number(right.source.updatedAt);
      const leftRecency = Number.isFinite(leftUpdatedAt)
        ? leftUpdatedAt
        : left.sourceIndex;
      const rightRecency = Number.isFinite(rightUpdatedAt)
        ? rightUpdatedAt
        : right.sourceIndex;
      if (leftRecency !== rightRecency) {
        return rightRecency - leftRecency;
      }
      return right.sourceIndex - left.sourceIndex;
    })
    .map(({ source }) => {
      const host = resolveListPanelHost(
        input.panelIds,
        input.getPanelTabIds,
        source.id,
      );
      const active = host
        ? input.getPanelActiveTabId(host.panelId) === source.id
        : input.globalActiveTabId === source.id;
      return {
        ...source,
        host,
        active,
        canDrag: true,
      };
    });
};

export const resolveListPanelRowActivation = (
  row: ListPanelRow,
): ListPanelRowActivation => {
  if (row.host) {
    return {
      type: "select",
      panelId: row.host.panelId,
      tabId: row.id,
    };
  }

  return {
    type: "open",
    kind: row.kind,
    tabId: row.id,
    hostPanelId: null,
  };
};

export const resolveCreatedTerminalTabActivation = (input: {
  tabId: string;
  hostPanelId: string | null;
}): ListPanelCreatedTerminalActivation => {
  if (!input.hostPanelId) {
    return { type: "none" };
  }
  return {
    type: "activate-host",
    panelId: input.hostPanelId,
    tabId: input.tabId,
  };
};
