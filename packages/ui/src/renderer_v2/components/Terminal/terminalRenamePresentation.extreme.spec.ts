import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const readSibling = (relativePath: string): string =>
  readFileSync(join(currentDir, relativePath), "utf8");

const terminalPanel = readSibling("TerminalPanel.tsx");
const dialog = readSibling("TerminalRenameDialog.tsx");
const layoutWorkspace = readSibling("../Layout/LayoutWorkspace.tsx");
const compactSelector = readSibling("../Layout/CompactPanelTabSelect.tsx");
const listPanel = readSibling("../ListPanel/ListPanel.tsx");
const preload = readFileSync(
  join(currentDir, "../../../../../../apps/electron/src/preload/index.ts"),
  "utf8",
);
const ipcAdapter = readFileSync(
  join(
    currentDir,
    "../../../../../electron/src/gateway/ElectronGatewayIpcAdapter.ts",
  ),
  "utf8",
);

assert.match(
  terminalPanel,
  /onContextMenu: onLayoutHeaderContextMenu/,
  "compact terminal options should forward tab context-menu events",
);
assert.match(
  terminalPanel,
  /onContextMenu=\{\(event\) => \{/,
  "regular terminal tabs should expose a context-menu event",
);
assert.match(
  compactSelector,
  /option\.onContextMenu\?\.\(event\)/,
  "compact selector menu entries should preserve per-tab context-menu identity",
);
assert.match(
  layoutWorkspace,
  /action: "rename-terminal"/,
  "terminal panel context menus should expose Rename",
);
assert.match(
  layoutWorkspace,
  /<TerminalRenameDialog/,
  "terminal panel rename should use the shared dialog",
);
assert.match(
  listPanel,
  /resolveListPanelRowContextActions/,
  "ListPanel rows should resolve a terminal rename action",
);
assert.match(
  listPanel,
  /<TerminalRenameDialog/,
  "ListPanel terminal rename should use the shared dialog",
);
assert.match(
  dialog,
  /await store\.renameTerminal\(terminalId, normalizedDraft\)/,
  "the dialog should commit through AppStore rather than mutating UI state directly",
);
assert.match(
  preload,
  /ipcRenderer\.invoke\("terminal:rename", terminalId, title\)/,
  "preload should expose the terminal rename IPC endpoint",
);
assert.match(
  ipcAdapter,
  /"terminal:rename"/,
  "Electron main should register the terminal rename IPC endpoint",
);

console.log("terminalRenamePresentation.extreme.spec.ts passed");
