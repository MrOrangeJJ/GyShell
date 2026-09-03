import { readOpaqueNonBlankString } from "@gyshell/shared";
import { canReconnectTerminalRuntime } from "../../lib/terminalConnectionModel";
import { normalizeSessionTitleText } from "../../lib/sessionTitleDisplay";

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

export interface ListPanelChatSourceInput {
  id: string;
  title: string;
  loadedMessageCount: number;
  totalMessageCount?: number;
  isSessionBusy: boolean;
  updatedAt?: number;
}

export interface ListPanelChatSourceLabels {
  messages: (count: number) => string;
  running: string;
  ready: string;
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

export const buildListPanelChatSources = (
  sessions: readonly ListPanelChatSourceInput[],
  labels: ListPanelChatSourceLabels,
): ListPanelTabSource[] =>
  sessions.map((session) => {
    const loadedMessageCount = Math.max(
      0,
      Math.floor(Number(session.loadedMessageCount) || 0),
    );
    const totalMessageCount = Math.max(
      loadedMessageCount,
      Math.floor(Number(session.totalMessageCount) || 0),
    );
    // Loaded messages are a mutable pagination window, so they must never
    // determine directory order. Only stable session metadata owns recency.
    const metadataUpdatedAt = Number(session.updatedAt);
    const stableUpdatedAt = Number.isFinite(metadataUpdatedAt)
      ? metadataUpdatedAt
      : undefined;

    return {
      id: session.id,
      kind: "chat",
      title: normalizeSessionTitleText(session.title),
      subtitle:
        totalMessageCount > 0
          ? labels.messages(totalMessageCount)
          : session.isSessionBusy
            ? labels.running
            : labels.ready,
      statusLabel: resolveListPanelChatStatusLabel(session.isSessionBusy),
      updatedAt: stableUpdatedAt,
    };
  });

export const resolveListPanelRowContextActions = (input: {
  kind: ListPanelTabKind;
  terminalType?: string;
  terminalRuntimeState?: unknown;
}): ListPanelRowContextAction[] => {
  if (input.kind === "chat") {
    return ["rename"];
  }

  const actions: ListPanelRowContextAction[] = ["rename"];
  if (
    input.terminalType &&
    canReconnectTerminalRuntime(
      { type: input.terminalType },
      input.terminalRuntimeState,
    )
  ) {
    actions.push("reconnect");
  }
  return actions;
};

export const resolveListPanelHost = (
  panelIds: readonly string[],
  getPanelTabIds: (panelId: string) => readonly string[],
  tabId: string,
): ListPanelHostInfo | null => {
  const normalizedTabId = readOpaqueNonBlankString(tabId);
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
