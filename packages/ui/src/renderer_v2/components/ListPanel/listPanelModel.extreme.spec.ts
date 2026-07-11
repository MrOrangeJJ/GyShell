import {
  buildListPanelRows,
  resolveCreatedTerminalTabActivation,
  resolveListPanelChatStatusLabel,
  resolveListPanelHost,
  resolveListPanelRowContextAction,
  resolveListPanelRowActivation,
  type ListPanelTabSource,
} from "./listPanelModel";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    );
  }
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const sources: ListPanelTabSource[] = [
  {
    id: "term-a",
    kind: "terminal",
    title: "Local",
    subtitle: "Local",
    statusLabel: "ready",
    updatedAt: 10,
  },
  {
    id: "term-b",
    kind: "terminal",
    title: "Server",
    subtitle: "SSH",
    statusLabel: "ready",
    updatedAt: 30,
  },
  {
    id: "term-unhosted",
    kind: "terminal",
    title: "Detached",
    subtitle: "Local",
    statusLabel: "ready",
    updatedAt: 20,
  },
];

runCase(
  "host resolution finds the exact source panel and tab index across repeated panel kinds",
  () => {
    const host = resolveListPanelHost(
      ["panel-term-1", "panel-term-2"],
      (panelId) => (panelId === "panel-term-1" ? ["term-a"] : ["term-b"]),
      "term-b",
    );

    assertDeepEqual(
      host,
      {
        panelId: "panel-term-2",
        panelIndex: 1,
        tabIndex: 0,
      },
      "host should point to the second terminal panel",
    );
  },
);

runCase(
  "rows keep newest entries first and expose drag payloads for shadow rows",
  () => {
    const rows = buildListPanelRows({
      sources,
      visibleTabIds: ["term-a", "term-b", "term-unhosted"],
      panelIds: ["panel-term-1"],
      getPanelTabIds: () => ["term-a", "term-b"],
      getPanelActiveTabId: () => "term-b",
      globalActiveTabId: "term-unhosted",
    });

    assertEqual(
      rows.length,
      3,
      "all visible terminal sources should be listed",
    );
    assertDeepEqual(
      rows.map((row) => row.id),
      ["term-b", "term-unhosted", "term-a"],
      "newer terminal rows should render above older rows",
    );
    assertEqual(rows[0].canDrag, true, "hosted tab should be draggable");
    assertEqual(
      rows[0].active,
      true,
      "host active tab should drive row active state",
    );
    assertEqual(
      rows[1].host,
      null,
      "unhosted inventory tab should not have a host",
    );
    assertEqual(
      rows[1].canDrag,
      true,
      "unhosted tab should still expose drag payload",
    );
    assertEqual(
      rows[1].active,
      true,
      "global active state should still be visible for an unhosted tab",
    );
  },
);

runCase("row activation selects hosted rows but opens unhosted rows", () => {
  const rows = buildListPanelRows({
    sources,
    visibleTabIds: ["term-a", "term-b", "term-unhosted"],
    panelIds: ["panel-term-1"],
    getPanelTabIds: () => ["term-a", "term-b"],
    getPanelActiveTabId: () => "term-a",
    globalActiveTabId: "term-unhosted",
  });

  const hostedRow = rows.find((row) => row.id === "term-b");
  const unhostedRow = rows.find((row) => row.id === "term-unhosted");
  if (!hostedRow || !unhostedRow) {
    throw new Error("Expected hosted and unhosted rows to be present");
  }

  assertDeepEqual(
    resolveListPanelRowActivation(hostedRow),
    {
      type: "select",
      panelId: "panel-term-1",
      tabId: "term-b",
    },
    "single-clicking a hosted row should only select its existing host panel",
  );
  assertDeepEqual(
    resolveListPanelRowActivation(unhostedRow),
    {
      type: "open",
      kind: "terminal",
      tabId: "term-unhosted",
      hostPanelId: null,
    },
    "single-clicking an unhosted row should restore it through the open path",
  );
});

runCase("chat status dots are green only for busy sessions", () => {
  assertEqual(
    resolveListPanelChatStatusLabel(true),
    "running",
    "busy chat sessions should use the running status dot",
  );
  assertEqual(
    resolveListPanelChatStatusLabel(false),
    "inactive",
    "idle chat sessions should use the inactive status dot",
  );
});

runCase(
  "created terminal tabs activate only an existing host panel",
  () => {
    assertDeepEqual(
      resolveCreatedTerminalTabActivation({
        tabId: "term-new",
        hostPanelId: "panel-terminal",
      }),
      {
        type: "activate-host",
        panelId: "panel-terminal",
        tabId: "term-new",
      },
      "created terminal tabs should activate the existing terminal panel",
    );
    assertDeepEqual(
      resolveCreatedTerminalTabActivation({
        tabId: "term-new",
        hostPanelId: null,
      }),
      { type: "none" },
      "created terminal tabs should not create a terminal panel from the list panel",
    );
  },
);

runCase(
  "row context actions match terminal reconnect and chat rename rules",
  () => {
    assertEqual(
      resolveListPanelRowContextAction({
        kind: "terminal",
        terminalType: "ssh",
        terminalRuntimeState: "exited",
      }),
      "reconnect",
      "an exited SSH terminal should expose reconnect",
    );
    assertEqual(
      resolveListPanelRowContextAction({
        kind: "terminal",
        terminalType: "ssh",
        terminalRuntimeState: "ready",
      }),
      null,
      "a ready SSH terminal should not expose reconnect",
    );
    assertEqual(
      resolveListPanelRowContextAction({
        kind: "terminal",
        terminalType: "local",
        terminalRuntimeState: "exited",
      }),
      null,
      "an exited local terminal should not expose reconnect",
    );
    assertEqual(
      resolveListPanelRowContextAction({ kind: "chat" }),
      "rename",
      "chat rows should always expose rename",
    );
  },
);

runCase(
  "visible tab inventory filters suppressed or detached-away tabs before host resolution",
  () => {
    const rows = buildListPanelRows({
      sources,
      visibleTabIds: ["term-a"],
      panelIds: ["panel-term-1"],
      getPanelTabIds: () => ["term-a", "term-b"],
      getPanelActiveTabId: () => "term-a",
      globalActiveTabId: null,
    });

    assertEqual(rows.length, 1, "suppressed inventory rows should not render");
    assertEqual(
      rows[0].id,
      "term-a",
      "remaining row should be the visible tab",
    );
  },
);

console.log("All ListPanel model extreme tests passed.");
