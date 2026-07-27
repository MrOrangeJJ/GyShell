import {
  DetachedWindowRegistry,
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
