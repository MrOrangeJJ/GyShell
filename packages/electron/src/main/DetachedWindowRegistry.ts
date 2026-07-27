export type DetachedWindowTabKind =
  | "chat"
  | "terminal"
  | "filesystem"
  | "monitor";

export interface DetachedWindowTabTarget {
  kind: DetachedWindowTabKind;
  tabId: string;
}

export type DetachedWindowTabOwnership = Partial<
  Record<DetachedWindowTabKind, string[]>
>;

export interface DetachedWindowHandle {
  id: number;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  moveTop?: () => void;
}

const TAB_KINDS: DetachedWindowTabKind[] = [
  "chat",
  "terminal",
  "filesystem",
  "monitor",
];

const normalizeTabIds = (tabIds: unknown): Set<string> => {
  if (!Array.isArray(tabIds)) {
    return new Set<string>();
  }
  return new Set(
    tabIds
      .map((tabId) => String(tabId || "").trim())
      .filter((tabId) => tabId.length > 0),
  );
};

const normalizeOwnership = (
  ownership: DetachedWindowTabOwnership | null | undefined,
): Record<DetachedWindowTabKind, Set<string>> => ({
  chat: normalizeTabIds(ownership?.chat),
  terminal: normalizeTabIds(ownership?.terminal),
  filesystem: normalizeTabIds(ownership?.filesystem),
  monitor: normalizeTabIds(ownership?.monitor),
});

export class DetachedWindowRegistry<
  TWindow extends DetachedWindowHandle = DetachedWindowHandle,
> {
  private records = new Map<
    number,
    {
      window: TWindow;
      tabsByKind: Record<DetachedWindowTabKind, Set<string>>;
    }
  >();

  register(
    window: TWindow,
    ownership?: DetachedWindowTabOwnership | null,
  ): void {
    if (window.isDestroyed()) {
      return;
    }
    this.records.set(window.id, {
      window,
      tabsByKind: normalizeOwnership(ownership),
    });
  }

  updateOwnership(
    window: TWindow,
    ownership?: DetachedWindowTabOwnership | null,
  ): boolean {
    const record = this.records.get(window.id);
    if (!record || record.window !== window || window.isDestroyed()) {
      this.records.delete(window.id);
      return false;
    }
    record.tabsByKind = normalizeOwnership(ownership);
    return true;
  }

  unregister(window: TWindow): void {
    const record = this.records.get(window.id);
    if (record?.window === window) {
      this.records.delete(window.id);
    }
  }

  findWindowHostingTab(target: DetachedWindowTabTarget): TWindow | null {
    const tabId = String(target.tabId || "").trim();
    if (!tabId || !TAB_KINDS.includes(target.kind)) {
      return null;
    }
    for (const [windowId, record] of this.records) {
      if (record.window.isDestroyed()) {
        this.records.delete(windowId);
        continue;
      }
      if (record.tabsByKind[target.kind].has(tabId)) {
        return record.window;
      }
    }
    return null;
  }

  focusWindowHostingTab(target: DetachedWindowTabTarget): TWindow | null {
    const window = this.findWindowHostingTab(target);
    if (!window) {
      return null;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    window.moveTop?.();
    return window;
  }

  getWindows(): TWindow[] {
    const windows: TWindow[] = [];
    for (const [windowId, record] of this.records) {
      if (record.window.isDestroyed()) {
        this.records.delete(windowId);
        continue;
      }
      windows.push(record.window);
    }
    return windows;
  }

  collectOwnership(): DetachedWindowTabOwnership {
    const tabIdsByKind: Record<DetachedWindowTabKind, Set<string>> = {
      chat: new Set<string>(),
      terminal: new Set<string>(),
      filesystem: new Set<string>(),
      monitor: new Set<string>(),
    };
    for (const window of this.getWindows()) {
      const record = this.records.get(window.id);
      if (!record) continue;
      TAB_KINDS.forEach((kind) => {
        record.tabsByKind[kind].forEach((tabId) =>
          tabIdsByKind[kind].add(tabId),
        );
      });
    }
    return {
      chat: Array.from(tabIdsByKind.chat),
      terminal: Array.from(tabIdsByKind.terminal),
      filesystem: Array.from(tabIdsByKind.filesystem),
      monitor: Array.from(tabIdsByKind.monitor),
    };
  }
}
