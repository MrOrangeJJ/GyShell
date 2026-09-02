import {
  isValidTerminalRuntimeId,
  readOpaqueNonBlankWellFormedString,
} from "@gyshell/shared";

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

export interface DetachedWindowOpenOptions {
  tabOwnership?: DetachedWindowTabOwnership;
  focusTarget?: DetachedWindowTabTarget;
}

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

const isDetachedWindowTabKind = (
  value: unknown,
): value is DetachedWindowTabKind =>
  value === "chat" ||
  value === "terminal" ||
  value === "filesystem" ||
  value === "monitor";

const isPlainRecord = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const hasOnlyKeys = (
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean => {
  try {
    const allowed = new Set(allowedKeys);
    return Reflect.ownKeys(value).every(
      (key) => typeof key === "string" && allowed.has(key),
    );
  } catch {
    return false;
  }
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readTabId = (
  kind: DetachedWindowTabKind,
  value: unknown,
): string | undefined => {
  const tabId = readOpaqueNonBlankWellFormedString(value);
  if (!tabId) return undefined;
  return kind === "chat" || isValidTerminalRuntimeId(tabId)
    ? tabId
    : undefined;
};

export type NormalizedDetachedWindowTabOwnership = Record<
  DetachedWindowTabKind,
  string[]
>;

export const normalizeDetachedWindowTabOwnership = (
  ownership: unknown,
): NormalizedDetachedWindowTabOwnership | null => {
  try {
    if (ownership === undefined) {
      return { chat: [], terminal: [], filesystem: [], monitor: [] };
    }
    if (!isPlainRecord(ownership) || !hasOnlyKeys(ownership, TAB_KINDS)) {
      return null;
    }

    const normalized = {
      chat: [],
      terminal: [],
      filesystem: [],
      monitor: [],
    } as NormalizedDetachedWindowTabOwnership;
    for (const kind of TAB_KINDS) {
      if (!hasOwn(ownership, kind)) continue;
      const values = ownership[kind];
      if (!Array.isArray(values)) return null;
      const seen = new Set<string>();
      for (const value of values) {
        const tabId = readTabId(kind, value);
        if (!tabId) return null;
        if (seen.has(tabId)) continue;
        seen.add(tabId);
        normalized[kind].push(tabId);
      }
    }
    return normalized;
  } catch {
    return null;
  }
};

const toOwnershipSets = (
  ownership: NormalizedDetachedWindowTabOwnership,
): Record<DetachedWindowTabKind, Set<string>> => ({
  chat: new Set(ownership.chat),
  terminal: new Set(ownership.terminal),
  filesystem: new Set(ownership.filesystem),
  monitor: new Set(ownership.monitor),
});

export const normalizeDetachedWindowTabTarget = (
  value: unknown,
): DetachedWindowTabTarget | null => {
  try {
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, ["kind", "tabId"]) ||
      !hasOwn(value, "kind") ||
      !hasOwn(value, "tabId") ||
      !isDetachedWindowTabKind(value.kind)
    ) {
      return null;
    }
    const tabId = readTabId(value.kind, value.tabId);
    return tabId ? { kind: value.kind, tabId } : null;
  } catch {
    return null;
  }
};

export const normalizeDetachedWindowOpenOptions = (
  value: unknown,
): {
  tabOwnership: NormalizedDetachedWindowTabOwnership;
  focusTarget?: DetachedWindowTabTarget;
} | null => {
  try {
    if (value === undefined) {
      return {
        tabOwnership: {
          chat: [],
          terminal: [],
          filesystem: [],
          monitor: [],
        },
      };
    }
    if (
      !isPlainRecord(value) ||
      !hasOnlyKeys(value, ["tabOwnership", "focusTarget"])
    ) {
      return null;
    }

    if (hasOwn(value, "tabOwnership") && value.tabOwnership === undefined) {
      return null;
    }
    const tabOwnership = normalizeDetachedWindowTabOwnership(
      hasOwn(value, "tabOwnership") ? value.tabOwnership : undefined,
    );
    if (!tabOwnership) return null;

    let focusTarget: DetachedWindowTabTarget | undefined;
    if (hasOwn(value, "focusTarget")) {
      focusTarget =
        normalizeDetachedWindowTabTarget(value.focusTarget) ?? undefined;
      if (!focusTarget) return null;
    }
    return {
      tabOwnership,
      ...(focusTarget ? { focusTarget } : {}),
    };
  } catch {
    return null;
  }
};

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
  ): boolean {
    const normalizedOwnership = normalizeDetachedWindowTabOwnership(ownership);
    if (window.isDestroyed() || !normalizedOwnership) {
      return false;
    }
    const existing = this.records.get(window.id);
    if (
      existing &&
      existing.window !== window &&
      !existing.window.isDestroyed()
    ) {
      return false;
    }
    this.records.set(window.id, {
      window,
      tabsByKind: toOwnershipSets(normalizedOwnership),
    });
    return true;
  }

  updateOwnership(
    window: TWindow,
    ownership?: DetachedWindowTabOwnership | null,
  ): boolean {
    const normalizedOwnership = normalizeDetachedWindowTabOwnership(ownership);
    if (!normalizedOwnership) return false;

    const record = this.records.get(window.id);
    if (!record || record.window !== window) {
      return false;
    }
    if (window.isDestroyed()) {
      this.records.delete(window.id);
      return false;
    }
    record.tabsByKind = toOwnershipSets(normalizedOwnership);
    return true;
  }

  unregister(window: TWindow): void {
    const record = this.records.get(window.id);
    if (record?.window === window) {
      this.records.delete(window.id);
    }
  }

  findWindowHostingTab(target: DetachedWindowTabTarget): TWindow | null {
    const normalizedTarget = normalizeDetachedWindowTabTarget(target);
    if (!normalizedTarget || !TAB_KINDS.includes(normalizedTarget.kind)) {
      return null;
    }
    const { kind, tabId } = normalizedTarget;
    for (const [windowId, record] of this.records) {
      if (record.window.isDestroyed()) {
        this.records.delete(windowId);
        continue;
      }
      if (record.tabsByKind[kind].has(tabId)) {
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
