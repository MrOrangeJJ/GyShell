import {
  DetachedWindowRegistry,
  normalizeDetachedWindowOpenOptions,
  normalizeDetachedWindowTabOwnership,
  normalizeDetachedWindowTabTarget,
  type DetachedWindowHandle,
} from "./DetachedWindowRegistry";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const createWindow = (id: number) => {
  const calls: string[] = [];
  let destroyed = false;
  let minimized = false;
  const window: DetachedWindowHandle = {
    id,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => {
      calls.push("restore");
      minimized = false;
    },
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
    moveTop: () => calls.push("moveTop"),
  };
  return {
    window,
    calls,
    minimize: () => {
      minimized = true;
    },
    destroy: () => {
      destroyed = true;
    },
  };
};

runCase("focus reuses the detached window that owns the requested tab", () => {
  const registry = new DetachedWindowRegistry();
  const windowA = createWindow(11);
  const windowB = createWindow(12);
  registry.register(windowA.window, {
    terminal: ["term-a"],
  });
  registry.register(windowB.window, {
    terminal: ["term-b"],
  });
  windowB.minimize();

  const focused = registry.focusWindowHostingTab({
    kind: "terminal",
    tabId: "term-b",
  });

  assertEqual(
    focused,
    windowB.window,
    "the existing tab host should be reused",
  );
  assertEqual(
    windowB.calls.join(","),
    "restore,show,focus,moveTop",
    "the reused window should be restored and brought to the front",
  );
  assertEqual(
    windowA.calls.length,
    0,
    "unrelated detached windows should not be changed",
  );
});

runCase(
  "ownership updates move tab lookup without leaving stale matches",
  () => {
    const registry = new DetachedWindowRegistry();
    const windowA = createWindow(21);
    registry.register(windowA.window, {
      terminal: ["term-a"],
      filesystem: ["term-a"],
    });

    registry.updateOwnership(windowA.window, {
      terminal: ["term-b"],
    });

    assertEqual(
      registry.findWindowHostingTab({
        kind: "terminal",
        tabId: "term-a",
      }),
      null,
      "old ownership should be replaced",
    );
    assertEqual(
      registry.findWindowHostingTab({
        kind: "filesystem",
        tabId: "term-a",
      }),
      null,
      "removed panel kinds should not retain stale ownership",
    );
    assertEqual(
      registry.findWindowHostingTab({
        kind: "terminal",
        tabId: "term-b",
      }),
      windowA.window,
      "new ownership should be discoverable",
    );
    assertEqual(
      JSON.stringify(registry.collectOwnership()),
      JSON.stringify({
        chat: [],
        terminal: ["term-b"],
        filesystem: [],
        monitor: [],
      }),
      "layout switching should be able to reclaim the complete child ownership inventory",
    );
  },
);

runCase("ownership preserves exact opaque ids and __proto__ safely", () => {
  const registry = new DetachedWindowRegistry();
  const windowA = createWindow(25);
  const ids = [" Terminal ", "Terminal", "terminal", "终端🙂", "__proto__"];

  assertEqual(
    registry.register(windowA.window, { chat: ids }),
    true,
    "valid exact ownership should register",
  );
  ids.forEach((tabId) => {
    assertEqual(
      registry.findWindowHostingTab({ kind: "chat", tabId }),
      windowA.window,
      `exact chat id ${JSON.stringify(tabId)} should remain discoverable`,
    );
  });
  assertEqual(
    registry.findWindowHostingTab({ kind: "chat", tabId: " terminal " }),
    null,
    "case- or whitespace-distinct lookalikes must not match",
  );
});

runCase("malformed ownership updates fail atomically", () => {
  const registry = new DetachedWindowRegistry();
  const windowA = createWindow(26);
  registry.register(windowA.window, { terminal: ["term-stable"] });

  assertEqual(
    registry.updateOwnership(windowA.window, {
      terminal: ["term-new", "   "] as any,
    }),
    false,
    "one malformed id should reject the whole ownership update",
  );
  assertEqual(
    registry.findWindowHostingTab({
      kind: "terminal",
      tabId: "term-stable",
    }),
    windowA.window,
    "a rejected update must leave prior ownership intact",
  );
  assertEqual(
    registry.findWindowHostingTab({ kind: "terminal", tabId: "term-new" }),
    null,
    "a rejected update must not partially install valid ids",
  );

  assertEqual(
    normalizeDetachedWindowTabOwnership({ terminal: null }),
    null,
    "explicit null kind arrays must reject",
  );
  assertEqual(
    normalizeDetachedWindowTabOwnership({ unknown: [] }),
    null,
    "unknown ownership keys must reject",
  );
  assertEqual(
    normalizeDetachedWindowTabOwnership(
      Object.assign(Object.create({ inherited: true }), { chat: [] }),
    ),
    null,
    "prototype-bearing ownership records must reject",
  );

  const symbolOwnership = { chat: ["chat-safe"] } as Record<PropertyKey, unknown>;
  Object.defineProperty(symbolOwnership, Symbol("unexpected"), {
    value: true,
    enumerable: false,
  });
  assertEqual(
    normalizeDetachedWindowTabOwnership(symbolOwnership),
    null,
    "symbol ownership keys must reject even when non-enumerable",
  );

  const throwingOwnership = new Proxy(
    { chat: ["chat-safe"] },
    {
      ownKeys: () => {
        throw new Error("hostile ownKeys trap");
      },
    },
  );
  assertEqual(
    normalizeDetachedWindowTabOwnership(throwingOwnership),
    null,
    "proxy trap failures must fail closed",
  );
});

runCase("detached open options and focus targets are strict", () => {
  const exactId = " Chat #]::🙂 ";
  const normalized = normalizeDetachedWindowOpenOptions({
    tabOwnership: { chat: [exactId, exactId] },
    focusTarget: { kind: "chat", tabId: exactId },
  });
  assertEqual(
    JSON.stringify(normalized),
    JSON.stringify({
      tabOwnership: {
        chat: [exactId],
        terminal: [],
        filesystem: [],
        monitor: [],
      },
      focusTarget: { kind: "chat", tabId: exactId },
    }),
    "open options should preserve exact ids and collapse only exact duplicates",
  );
  assertEqual(
    normalizeDetachedWindowOpenOptions(null),
    null,
    "explicit null options must reject",
  );
  assertEqual(
    normalizeDetachedWindowOpenOptions({ extra: true }),
    null,
    "unknown option keys must reject",
  );
  assertEqual(
    normalizeDetachedWindowOpenOptions({ focusTarget: null }),
    null,
    "explicit null focus targets must reject",
  );
  assertEqual(
    normalizeDetachedWindowTabTarget({
      kind: "chat",
      tabId: exactId,
      extra: true,
    }),
    null,
    "focus target unknown keys must reject",
  );
  assertEqual(
    normalizeDetachedWindowTabTarget({ kind: "terminal", tabId: "\ud800" }),
    null,
    "malformed UTF-16 terminal ids must reject",
  );
});

runCase("window id collisions and mismatched updates preserve live ownership", () => {
  const registry = new DetachedWindowRegistry();
  const original = createWindow(29);
  const colliding = createWindow(29);
  assertEqual(
    registry.register(original.window, { terminal: ["term-original"] }),
    true,
    "the original window should register",
  );
  assertEqual(
    registry.register(colliding.window, { terminal: ["term-colliding"] }),
    false,
    "a live colliding window handle must not replace the original",
  );
  assertEqual(
    registry.updateOwnership(colliding.window, {
      terminal: ["term-colliding"],
    }),
    false,
    "a mismatched handle must not update ownership",
  );
  assertEqual(
    registry.findWindowHostingTab({
      kind: "terminal",
      tabId: "term-original",
    }),
    original.window,
    "rejected colliding operations must preserve original ownership",
  );
  assertEqual(
    registry.findWindowHostingTab({
      kind: "terminal",
      tabId: "term-colliding",
    }),
    null,
    "rejected colliding operations must not install new ownership",
  );
});

runCase("destroyed and unregistered windows cannot be reused", () => {
  const registry = new DetachedWindowRegistry();
  const destroyedWindow = createWindow(31);
  registry.register(destroyedWindow.window, {
    chat: ["chat-a"],
  });
  destroyedWindow.destroy();

  assertEqual(
    registry.getWindows().length,
    0,
    "destroyed windows should be pruned",
  );

  const closedWindow = createWindow(32);
  registry.register(closedWindow.window, {
    chat: ["chat-b"],
  });
  registry.unregister(closedWindow.window);
  assertEqual(
    registry.findWindowHostingTab({
      kind: "chat",
      tabId: "chat-b",
    }),
    null,
    "unregistered windows should not remain discoverable",
  );
});
